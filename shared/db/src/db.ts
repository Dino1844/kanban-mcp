import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";

const SCHEMA_VERSION = 3;

export class ColumnCapacityFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColumnCapacityFullError';
    
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ColumnCapacityFullError);
    }
  }
}

export interface Board {
  id: string;
  name: string;
  goal: string;
  landing_column_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Column {
  id: string;
  board_id: string;
  name: string;
  position: number;
  wip_limit: number;
  is_done_column: number;
}

export interface Task {
  id: string;
  column_id: string;
  title: string;
  content: string;
  position: number;
  created_at: string;
  updated_at: string;
  update_reason?: string;
  metadata?: string;
  priority?: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  updateReason?: string;
  priority?: string;
  metadata?: string;
}

export interface ColumnWithTasks {
  id: string;
  name: string;
  position: number;
  wipLimit: number;
  isLanding: boolean;
  tasks: TaskSummary[];
}

export interface ColumnDefinition {
  name: string;
  position: number;
  wipLimit: number;
  isDoneColumn?: boolean;
}

export class KanbanDB {
  constructor(private db: Database.Database) {
    this.createSchemaIfNotExists();
  }

  public close(): void {
    this.db.close();
  }

  public createBoard(
    name: string,
    projectGoal: string,
    columns: ColumnDefinition[],
    landingColumnPosition: number
  ): { boardId: string; landingColumnId: string | null } {
    if (columns.length === 0) {
      throw new Error("At least one column is required to create a board");
    }

    if (landingColumnPosition < 0 || landingColumnPosition >= columns.length) {
      throw new Error(
        `Landing column position ${landingColumnPosition} is out of bounds for the provided columns`
      );
    }

    const boardId = this.generateUUID();
    const now = new Date().toISOString();
    let landingColumnId: string | null = null;

    const transaction = this.db.transaction(() => {
      // Insert the new board into the database (without landing column for now)
      const insertBoardStmt = this.db.prepare<
        [string, string, string, string, string, string]
      >(`
        INSERT INTO boards (id, name, goal, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertBoardStmt.run(boardId, name, projectGoal, "active", now, now);

      const insertColumnStmt = this.db.prepare<
        [string, string, string, number, number, number]
      >(`
        INSERT INTO columns (id, board_id, name, position, wip_limit, is_done_column)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const column of columns) {
        const columnId = this.generateUUID();
        insertColumnStmt.run(
          columnId,
          boardId,
          column.name,
          column.position,
          column.wipLimit,
          column.isDoneColumn ? 1 : 0
        );

        if (column.position === landingColumnPosition) {
          landingColumnId = columnId;
        }
      }

      // Update the board with the landing column ID
      const updateBoardStmt = this.db.prepare<[string | null, string]>(`
        UPDATE boards
        SET landing_column_id = ?
        WHERE id = ?
      `);

      updateBoardStmt.run(landingColumnId, boardId);
    });

    // Execute the transaction
    transaction();

    return { boardId, landingColumnId };
  }

  public getBoardById(boardId: string): Board | undefined {
    const findBoardStmt = this.db.prepare<[string], Board>(`
      SELECT id, name, goal, landing_column_id, status, created_at, updated_at 
      FROM boards 
      WHERE id = ?
    `);

    return findBoardStmt.get(boardId);
  }

  public getColumnById(columnId: string): Column | undefined {
    const findColumnStmt = this.db.prepare<[string], Column>(`
      SELECT id, board_id, name, position, wip_limit, is_done_column
      FROM columns 
      WHERE id = ?
    `);

    return findColumnStmt.get(columnId);
  }

  public getTaskById(taskId: string): Task | undefined {
    const findTaskStmt = this.db.prepare<[string], Task>(`
      SELECT id, column_id, title, content, position, created_at, updated_at, update_reason, metadata, priority
      FROM tasks 
      WHERE id = ?
    `);

    return findTaskStmt.get(taskId);
  }

  public countTasksInColumn(columnId: string): number {
    const countTasksStmt = this.db.prepare<[string], { count: number }>(`
      SELECT COUNT(*) as count FROM tasks
      WHERE column_id = ?
    `);

    const countResult = countTasksStmt.get(columnId);
    return countResult ? countResult.count : 0;
  }

  public addTaskToColumn(
    columnId: string,
    title: string,
    content: string,
    priority?: string,
    metadata?: string
  ): Task {
    // Get the column
    const column = this.getColumnById(columnId);
    if (!column) {
      throw new Error(`Column with ID ${columnId} not found`);
    }

    // Count existing tasks in the column
    const taskCount = this.countTasksInColumn(columnId);

    // Check if the column is full (WIP limit reached)
    if (column.wip_limit > 0 && taskCount >= column.wip_limit) {
      throw new ColumnCapacityFullError(`Cannot add task to "${column.name}" column. The column has reached its capacity (WIP limit) of ${column.wip_limit}.`);
    }

    const now = new Date().toISOString();
    const taskId = this.generateUUID();
    const position = taskCount;

    const insertTaskStmt = this.db.prepare<
      [string, string, string, string, number, string, string, string | null, string | null]
    >(`
      INSERT INTO tasks (id, column_id, title, content, position, created_at, updated_at, priority, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertTaskStmt.run(taskId, columnId, title, content, position, now, now, priority ?? null, metadata ?? null);

    return {
      id: taskId,
      column_id: columnId,
      title,
      content,
      position,
      created_at: now,
      updated_at: now,
      priority,
      metadata,
    };
  }

  public moveTask(taskId: string, targetColumnId: string, reason?: string): void {
    // Get the target column
    const targetColumn = this.getColumnById(targetColumnId);
    if (!targetColumn) {
      throw new Error(`Target column with ID ${targetColumnId} not found`);
    }

    // Count existing tasks in the target column
    const taskCount = this.countTasksInColumn(targetColumnId);

    // Check if the target column is full (WIP limit reached)
    if (targetColumn.wip_limit > 0 && taskCount >= targetColumn.wip_limit) {
      throw new ColumnCapacityFullError(`Cannot move task to "${targetColumn.name}" column. The column has reached its capacity limit of ${targetColumn.wip_limit}.`);
    }

    const now = new Date().toISOString();
    const position = taskCount;

    const updateTaskStmt = this.db.prepare<[string, number, string, string | null, string]>(`
      UPDATE tasks
      SET column_id = ?, position = ?, updated_at = ?, update_reason = ?
      WHERE id = ?
    `);

    updateTaskStmt.run(targetColumnId, position, now, reason || null, taskId);
  }

  public getColumnsForBoard(boardId: string): Column[] {
    const findColumnsStmt = this.db.prepare<[string], Column>(`
      SELECT id, board_id, name, position, wip_limit, is_done_column
      FROM columns
      WHERE board_id = ?
      ORDER BY position ASC
    `);

    return findColumnsStmt.all(boardId);
  }

  public getTasksForColumn(columnId: string): TaskSummary[] {
    const findTasksStmt = this.db.prepare<
      [string],
      {
        id: string;
        title: string;
        position: number;
        created_at: string;
        updated_at: string;
        update_reason?: string;
        metadata?: string;
        priority?: string;
      }
    >(`
      SELECT id, title, position, created_at, updated_at, update_reason, metadata, priority
      FROM tasks
      WHERE column_id = ?
      ORDER BY position ASC
    `);

    const tasks = findTasksStmt.all(columnId);

    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      position: task.position,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      updateReason: task.update_reason,
      metadata: task.metadata,
      priority: task.priority,
    }));
  }

  public getBoardWithColumnsAndTasks(
    boardId: string
  ): { board: Board; columns: ColumnWithTasks[] } | undefined {
    const board = this.getBoardById(boardId);

    if (!board) {
      return undefined;
    }

    const columns = this.getColumnsForBoard(boardId);
    const columnsWithTasks: ColumnWithTasks[] = [];

    for (const column of columns) {
      const tasks = this.getTasksForColumn(column.id);

      columnsWithTasks.push({
        id: column.id,
        name: column.name,
        position: column.position,
        wipLimit: column.wip_limit,
        isLanding: column.id === board.landing_column_id,
        tasks,
      });
    }

    return { board, columns: columnsWithTasks };
  }

  public getAllBoards(includeArchived = false): Board[] {
    if (includeArchived) {
      const findBoardsStmt = this.db.prepare<[], Board>(`
        SELECT id, name, goal, landing_column_id, status, created_at, updated_at
        FROM boards
        ORDER BY created_at DESC
      `);
      return findBoardsStmt.all();
    }

    const findBoardsStmt = this.db.prepare<[], Board>(`
      SELECT id, name, goal, landing_column_id, status, created_at, updated_at
      FROM boards
      WHERE status IS NULL OR status != 'archived'
      ORDER BY created_at DESC
    `);

    return findBoardsStmt.all();
  }

  public getBoardByName(name: string): Board | undefined {
    const findBoardStmt = this.db.prepare<[string], Board>(`
      SELECT id, name, goal, landing_column_id, status, created_at, updated_at
      FROM boards
      WHERE name = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);

    return findBoardStmt.get(name);
  }

  public archiveBoard(boardId: string): number {
    const stmt = this.db.prepare<[string, string]>(`
      UPDATE boards SET status = 'archived', updated_at = ? WHERE id = ?
    `);
    const now = new Date().toISOString();
    const res = stmt.run(now, boardId);
    return res.changes;
  }

  public updateTask(taskId: string, content: string, position?: number, priority?: string, metadata?: string): Task | undefined {
    // Get the task
    const task = this.getTaskById(taskId);
    if (!task) {
      return undefined;
    }

    const now = new Date().toISOString();

    const updateTaskStmt = this.db.prepare<[string, number | null, string | null, string | null, string, string]>(`
      UPDATE tasks
      SET content = ?, position = COALESCE(?, position), priority = COALESCE(?, priority), metadata = COALESCE(?, metadata), updated_at = ?
      WHERE id = ?
    `);

    updateTaskStmt.run(content, position ?? null, priority ?? null, metadata ?? null, now, taskId);

    // Return the updated task
    return {
      ...task,
      content,
      position: position ?? task.position,
      priority: priority ?? task.priority,
      metadata: metadata ?? task.metadata,
      updated_at: now
    };
  }

  public deleteTask(taskId: string): number {
    const deleteTaskStmt = this.db.prepare<[string]>(`
      DELETE FROM tasks
      WHERE id = ?
    `);

    const res = deleteTaskStmt.run(taskId);
    return res.changes;
  }

  public deleteBoard(boardId: string): number {
    // Use a transaction to ensure all related data is deleted
    const transaction = this.db.transaction(() => {
      // First, get all columns for this board
      const columns = this.getColumnsForBoard(boardId);
      
      // Delete all tasks in each column
      const deleteTasksStmt = this.db.prepare<[string]>(`
        DELETE FROM tasks
        WHERE column_id = ?
      `);
      
      for (const column of columns) {
        deleteTasksStmt.run(column.id);
      }
      
      // Delete all columns for this board
      const deleteColumnsStmt = this.db.prepare<[string]>(`
        DELETE FROM columns
        WHERE board_id = ?
      `);
      
      deleteColumnsStmt.run(boardId);
      
      // Finally, delete the board itself
      const deleteBoardStmt = this.db.prepare<[string]>(`
        DELETE FROM boards
        WHERE id = ?
      `);
      
      return deleteBoardStmt.run(boardId);
    });
    
    // Execute the transaction and return the number of changes
    const result = transaction();
    return result.changes;
  }

  private generateUUID(): string {
    return crypto.randomUUID();
  }

  private createSchemaIfNotExists(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        goal TEXT NOT NULL,
        landing_column_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS columns (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        wip_limit INTEGER NOT NULL,
        is_done_column INTEGER DEFAULT 0,
        FOREIGN KEY (board_id) REFERENCES boards(id)
      );
      
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        column_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        update_reason TEXT,
        metadata TEXT,
        FOREIGN KEY (column_id) REFERENCES columns(id)
      );
    `);

    // Idempotent migrations for newer columns on older DB files
    const safeAddColumn = (sql: string) => {
      try {
        this.db.exec(sql);
      } catch {
        // column already exists
      }
    };
    safeAddColumn(`ALTER TABLE tasks ADD COLUMN priority TEXT`);
    safeAddColumn(`ALTER TABLE boards ADD COLUMN status TEXT DEFAULT 'active'`);
    this.db.exec(`UPDATE boards SET status = 'active' WHERE status IS NULL`);
  }
}

export function createDBInstance(folderPath: string): Database.Database {
  const dbFilePath = folderPath + `/kanban_${SCHEMA_VERSION}.db`;

  // Create the folder if it doesn't exist
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  // Create the database instance
  const dbOptions: Database.Options = {
    //verbose: console.error,
  };
  const db = new Database(dbFilePath, dbOptions);
  db.pragma("journal_mode = WAL");

  return db;
}
