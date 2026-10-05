import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  KanbanDB,
  ColumnWithTasks,
  createDBInstance,
  ColumnCapacityFullError,
} from "@kanban-mcp/db";

dayjs.extend(relativeTime);

const mcpServer = new McpServer({
  name: "KanbanMCP",
  version: "1.1.0",
});

const folderPath = process.env.MCP_KANBAN_DB_FOLDER_PATH ?? "./db";
const db = createDBInstance(folderPath);
const kanbanDB = new KanbanDB(db);

// Resolve a board by ID or by name (agent often knows the name from list-boards).
function resolveBoard(idOrName: string) {
  const byId = kanbanDB.getBoardById(idOrName);
  if (byId) return byId;
  return kanbanDB.getBoardByName(idOrName);
}

mcpServer.tool(
  "create-kanban-board",
  "Create a new kanban board to plan and keep track of your tasks. Specify the goal of the project in 1-3 sentences.",
  { name: z.string(), projectGoal: z.string() },
  async ({ name, projectGoal }) => {
    const columns = [
      { name: "On Hold", position: 0, wipLimit: 0 }, // 0 means unlimited
      { name: "To Do", position: 1, wipLimit: 0 },
      { name: "In Progress", position: 2, wipLimit: 3 },
      { name: "Done", position: 3, wipLimit: 0, isDoneColumn: true },
    ];

    const landingColPos = 1; // The "To Do" column
    const { boardId } = kanbanDB.createBoard(
      name,
      projectGoal,
      columns,
      landingColPos
    );

    return {
      content: [
        {
          type: "text",
          text: `Created Kanban board "${name}" with ID: ${boardId}\n\nDefault columns created: ${columns
            .map((col: { name: string }) => col.name)
            .join(
              ", "
            )}\n\n"To Do" column set as landing column for new tasks.`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "add-task-to-board",
  "Add a new task to the landing column (to-do) of a kanban board. Provide a title and content for the task. The content is a markdown string that should include a short description of what needs to be done, why it needs to be done, as well as acceptance criteria.",
  {
    boardId: z.string(),
    title: z.string(),
    content: z.string(),
    columnId: z.string().optional(),
    columnName: z.string().optional(),
    priority: z.string().optional(),
    metadata: z.any().optional(),
  },
  async ({ boardId, title, content, columnId, columnName, priority, metadata }) => {
    const board = resolveBoard(boardId);

    if (!board) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find board with ID or name: ${boardId}`,
          },
        ],
        isError: true,
      };
    }

    // Determine target column: explicit columnId/columnName, else landing column
    let targetColumnId: string | undefined;

    if (columnId) {
      targetColumnId = columnId;
    } else if (columnName) {
      const cols = kanbanDB.getColumnsForBoard(board.id);
      const matched = cols.find(
        (c) => c.name.toLowerCase() === columnName.toLowerCase()
      );
      if (!matched) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Could not find column named "${columnName}" in board "${board.name}". Available: ${cols
                .map((c) => c.name)
                .join(", ")}`,
            },
          ],
          isError: true,
        };
      }
      targetColumnId = matched.id;
    } else {
      targetColumnId = board.landing_column_id ?? undefined;
    }

    if (!targetColumnId) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Board "${board.name}" does not have a landing column configured.`,
          },
        ],
        isError: true,
      };
    }

    const column = kanbanDB.getColumnById(targetColumnId);

    if (!column || column.board_id !== board.id) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find column "${columnId ?? columnName}" in board "${board.name}".`,
          },
        ],
        isError: true,
      };
    }

    const metadataStr =
      metadata === undefined || metadata === null
        ? undefined
        : typeof metadata === "string"
        ? metadata
        : JSON.stringify(metadata);

    let task;

    try {
      task = kanbanDB.addTaskToColumn(
        targetColumnId,
        title,
        content,
        priority,
        metadataStr
      );
    } catch (error) {
      if (error instanceof ColumnCapacityFullError) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}. Complete some tasks in this column first.`,
            },
          ],
          isError: true,
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Error occurred while adding the task`,
            },
          ],
          isError: true,
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Added task "${title}" to "${column.name}" column in board "${board.name}".\n\nTask ID: ${task.id}\nColumn ID: ${targetColumnId}\nBoard ID: ${board.id}\nPosition: ${task.position}${priority ? `\nPriority: ${priority}` : ""}\n\n${content}`,
        },
      ],
      taskInfo: {
        id: task.id,
        columnId: targetColumnId,
        boardId: board.id,
        title,
        content,
        position: task.position,
        priority,
        metadata: metadataStr,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
      },
    };
  }
);

mcpServer.tool(
  "move-task",
  "Move a task from one column to another, respecting WIP limits. Only move tasks into the Done column if the user approved that the task is done. When moving to Done, a short reason is required. You can specify the target column by ID (targetColumnId) or by name (targetColumnName).",
  {
    taskId: z.string(),
    targetColumnId: z.string().optional(),
    targetColumnName: z.string().optional(),
    reason: z.string().optional(),
  },
  async ({ taskId, targetColumnId, targetColumnName, reason }) => {
    const task = kanbanDB.getTaskById(taskId);

    if (!task) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find task with ID: ${taskId}`,
          },
        ],
        isError: true,
      };
    }

    if (!targetColumnId && !targetColumnName) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Provide either targetColumnId or targetColumnName.`,
          },
        ],
        isError: true,
      };
    }

    let resolvedTargetColumnId = targetColumnId;

    // If both id and name are provided, they must agree
    if (targetColumnId && targetColumnName) {
      const sourceCol = kanbanDB.getColumnById(task.column_id);
      if (sourceCol) {
        const cols = kanbanDB.getColumnsForBoard(sourceCol.board_id);
        const byName = cols.find(
          (c) => c.name.toLowerCase() === targetColumnName.toLowerCase()
        );
        if (byName && byName.id !== targetColumnId) {
          return {
            content: [
              {
                type: "text",
                text: `Error: targetColumnId "${targetColumnId}" does not match targetColumnName "${targetColumnName}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }

    if (!resolvedTargetColumnId && targetColumnName) {
      const sourceColumnForBoard = kanbanDB.getColumnById(task.column_id);

      if (!sourceColumnForBoard) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Could not find source column with ID: ${task.column_id}`,
            },
          ],
          isError: true,
        };
      }

      const boardColumns = kanbanDB.getColumnsForBoard(
        sourceColumnForBoard.board_id
      );
      const matched = boardColumns.find(
        (col) => col.name.toLowerCase() === targetColumnName.toLowerCase()
      );

      if (!matched) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Could not find column named "${targetColumnName}" in this board. Available columns: ${boardColumns
                .map((col) => col.name)
                .join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      resolvedTargetColumnId = matched.id;
    }

    // If the task is already in the target column, no need to move
    if (task.column_id === resolvedTargetColumnId) {
      return {
        content: [
          {
            type: "text",
            text: `Task is already in the target column.`,
          },
        ],
        isError: false,
      };
    }

    const targetColumn = kanbanDB.getColumnById(resolvedTargetColumnId!);

    if (!targetColumn) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find target column with ID: ${resolvedTargetColumnId}`,
          },
        ],
        isError: true,
      };
    }

    // Moving into a Done column requires a completion reason
    if (targetColumn.is_done_column === 1 && (!reason || !reason.trim())) {
      return {
        content: [
          {
            type: "text",
            text: `Error: A reason is required when moving a task to the "${targetColumn.name}" (Done) column. Provide a short completion reason.`,
          },
        ],
        isError: true,
      };
    }

    const sourceColumn = kanbanDB.getColumnById(task.column_id);

    if (!sourceColumn) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find source column with ID: ${task.column_id}`,
          },
        ],
        isError: true,
      };
    }

    try {
      kanbanDB.moveTask(taskId, resolvedTargetColumnId!, reason);
    } catch (error) {
      if (error instanceof ColumnCapacityFullError) {
        const existing = kanbanDB
          .getTasksForColumn(resolvedTargetColumnId!)
          .map((t) => `${t.title} (${t.id})`)
          .join("; ");
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}. Work on tasks in the "${targetColumn.name}" column first. Current tasks there: ${existing || "(none)"}.`,
            },
          ],
          isError: true,
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Error occurred while moving the task`,
            },
          ],
          isError: true,
        };
      }
    }

    const board = kanbanDB.getBoardById(targetColumn.board_id);
    const boardName = board ? board.name : "Unknown";

    return {
      content: [
        {
          type: "text",
          text: `Moved task "${task.title}" from "${sourceColumn.name}" to "${targetColumn.name}" column in board "${boardName}"`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "delete-task",
  "Delete a task from a kanban board.",
  {
    taskId: z.string(),
  },
  async ({ taskId }) => {
    const changes = kanbanDB.deleteTask(taskId);
    if (changes) {
      return {
        content: [
          {
            type: "text",
            text: `Deleted task with ID: ${taskId}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Error: Could not delete task with ID: ${taskId}`,
        },
      ],
      isError: true,
    };
  }
);

mcpServer.tool(
  "delete-board",
  "Delete a kanban board and all of its columns and tasks. Use with caution; this cannot be undone.",
  {
    boardId: z.string(),
  },
  async ({ boardId }) => {
    const board = resolveBoard(boardId);

    if (!board) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find board with ID or name: ${boardId}`,
          },
        ],
        isError: true,
      };
    }

    const changes = kanbanDB.deleteBoard(board.id);

    if (changes) {
      return {
        content: [
          {
            type: "text",
            text: `Deleted board "${board.name}" (ID: ${board.id}) and all its columns and tasks.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Error: Could not delete board with ID: ${boardId}`,
        },
      ],
      isError: true,
    };
  }
);

mcpServer.tool(
  "archive-board",
  "Archive a kanban board (mark it status=archived) without deleting its data. Archived boards are hidden from list-boards unless includeArchived is true.",
  {
    boardId: z.string(),
  },
  async ({ boardId }) => {
    const board = resolveBoard(boardId);

    if (!board) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find board with ID or name: ${boardId}`,
          },
        ],
        isError: true,
      };
    }

    const changes = kanbanDB.archiveBoard(board.id);

    if (changes) {
      return {
        content: [
          {
            type: "text",
            text: `Archived board "${board.name}" (ID: ${board.id}).`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Error: Could not archive board with ID: ${boardId}`,
        },
      ],
      isError: true,
    };
  }
);

mcpServer.tool(
  "update-task",
  "Update a task's content, position, priority, or metadata. Only provide the fields you want to change.",
  {
    taskId: z.string(),
    content: z.string().optional(),
    position: z.number().int().optional(),
    priority: z.string().optional(),
    metadata: z.any().optional(),
  },
  async ({ taskId, content, position, priority, metadata }) => {
    const task = kanbanDB.getTaskById(taskId);

    if (!task) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find task with ID: ${taskId}`,
          },
        ],
        isError: true,
      };
    }

    const metadataStr =
      metadata === undefined || metadata === null
        ? undefined
        : typeof metadata === "string"
        ? metadata
        : JSON.stringify(metadata);

    const updated = kanbanDB.updateTask(
      taskId,
      content !== undefined ? content : task.content,
      position,
      priority,
      metadataStr
    );

    if (!updated) {
      return {
        content: [
          { type: "text", text: `Error: Could not update task with ID: ${taskId}` },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Updated task "${updated.title}" (ID: ${updated.id}).${position !== undefined ? ` New position: ${updated.position}.` : ""}${priority ? ` New priority: ${updated.priority}.` : ""}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "get-board-info",
  "Get the full info of a kanban board, including columns and tasks (without task content). Set includeContent to true to also include each task's content.",
  {
    boardId: z.string(),
    includeContent: z.boolean().optional(),
  },
  async ({ boardId, includeContent }) => {
    const resolved = resolveBoard(boardId);
    const boardData = resolved
      ? kanbanDB.getBoardWithColumnsAndTasks(resolved.id)
      : undefined;

    if (!boardData) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find board with ID or name: ${boardId}`,
          },
        ],
        isError: true,
      };
    }

    const { board, columns } = boardData;

    const fullTaskListString = columns
      .map((col: ColumnWithTasks) => {
        return (
          `Column: ${col.name} (ID ${col.id}) (Capacity: ${
            col.wipLimit > 0 ? col.wipLimit : "unlimited"
          })\n` +
          col.tasks
            .map(
              (task: {
                title: string;
                id: string;
                position: number;
                createdAt: string;
                updatedAt: string;
                updateReason?: string;
                priority?: string;
              }) => {
                let taskInfo = `- ${task.title} (ID: ${task.id}, Position: ${
                  task.position
                }, Created At: ${dayjs(
                  task.createdAt
                ).fromNow()}, Updated At: ${dayjs(task.updatedAt).fromNow()}`;

                if (task.updateReason) {
                  taskInfo += `, Update reason: ${task.updateReason}`;
                }

                if (task.priority) {
                  taskInfo += `, Priority: ${task.priority}`;
                }

                taskInfo += ")";

                if (includeContent) {
                  const full = kanbanDB.getTaskById(task.id);
                  if (full) {
                    taskInfo += `\n  Content: ${full.content.replace(/\n/g, "\n  ")}`;
                    if (full.metadata) {
                      taskInfo += `\n  Metadata: ${full.metadata}`;
                    }
                  }
                }

                return taskInfo;
              }
            )
            .join("\n")
        );
      })
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Retrieved board "${board.name}" with ${
            columns.length
          } columns and ${columns.reduce(
            (total: number, col: ColumnWithTasks) => total + col.tasks.length,
            0
          )} tasks.\nBoard ID: ${board.id}\nStatus: ${board.status ?? "active"}`,
        },
        {
          type: "text",
          text: `Board goal:\n\n${board.goal}`,
        },
        {
          type: "text",
          text: `Board tasks:\n\n${fullTaskListString}\n\nUse get-task-info to get the full content of a task.`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "get-task-info",
  "Get the full info of a task, including its content.",
  {
    taskId: z.string(),
  },
  async ({ taskId }) => {
    const task = kanbanDB.getTaskById(taskId);

    if (!task) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not find task with ID: ${taskId}`,
          },
        ],
        isError: true,
      };
    }

    let responseText = `Retrieved task "${task.title}" with ID: ${task.id}.\n\nContent:\n\n${task.content}`;

    if (task.update_reason) {
      responseText += `\n\nUpdate reason: ${task.update_reason}`;
    }

    if (task.priority) {
      responseText += `\n\nPriority: ${task.priority}`;
    }

    if (task.metadata) {
      responseText += `\n\nMetadata: ${task.metadata}`;
    }

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }
);

mcpServer.tool(
  "list-boards",
  "List all kanban boards in the database: Name, creation time, goal, and status. Pass includeArchived=true to also list archived boards.",
  { includeArchived: z.boolean().optional() },
  async ({ includeArchived }) => {
    const boards = kanbanDB.getAllBoards(includeArchived ?? false);

    if (boards.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No boards found.`,
          },
        ],
      };
    }

    const boardListString = boards
      .map(
        (board: {
          name: string;
          id: string;
          created_at: string;
          goal: string;
          status?: string;
        }) =>
          `- ${board.name} (ID: ${board.id}, Created At: ${dayjs(
            board.created_at
          ).fromNow()}, Status: ${board.status ?? "active"}, Goal: ${board.goal})`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Retrieved ${boards.length} boards:\n\n${boardListString}`,
        },
      ],
    };
  }
);

mcpServer.prompt(
  "create-kanban-based-project",
  { description: z.string() },
  ({ description }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `
        Help me with the following project:\n\n${description}\n\n
        First, create a kanban board for the project. Use this kanban board to keep track 
        of the project.
        Then ask me questions about the project, one question at a time, in order to divide 
        the project into tasks, which you can add to the kanban board.
        Only add tasks that you can complete yourself with the provided tools at your disposal.
        When you are done adding all the tasks, show me an overview of the board.
        `,
        },
      },
    ],
  })
);

mcpServer.prompt(
  "make-progress-on-a-project",
  { project: z.string() },
  ({ project }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `
        Let's make progress on the following project:\n\n${project}\n\n
        Locate the kanban project in the list of boards. If it doesn't exist, tell me before creating one.
        After you located the correct board, get its info and pick the next task to work on.
        Move the task to the correct column before working on it, unless it's already in the correct column.
        Before moving a task to "done" make sure all the acceptance criteria are met, and if can't validate
        that by yourself, ask me if they are met.
        If you can't make progress, tell me why. 
        `,
        },
      },
    ],
  })
);

const transport = new StdioServerTransport();
mcpServer
  .connect(transport)
  .then(() => {
    console.error("MCP Server running on stdio");
  })
  .catch((err) => {
    console.error("MCP Server connection error", err);
    process.exit(1);
  });

async function closeServer() {
  console.error("Closing MCP Server");
  await mcpServer.close();
  kanbanDB.close();
}

process.stdin.on("close", async () => {
  console.error("MCP Server closed");
  await closeServer();
  process.exit(0);
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.error("Shutting down servers...");
  await closeServer;
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("Shutting down servers...");
  await closeServer();
  process.exit(0);
});
