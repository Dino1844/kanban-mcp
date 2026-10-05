import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import path from "path";
import { KanbanDB, ColumnCapacityFullError } from "@kanban-mcp/db";

/**
 * WebServer class that handles the web server functionality
 */
class WebServer {
  private server: FastifyInstance;
  private kanbanDB: KanbanDB;

  /**
   * Creates a new WebServer instance
   * @param kanbanDB The KanbanDB instance to use
   */
  constructor(kanbanDB: KanbanDB) {
    this.kanbanDB = kanbanDB;

    // Create Fastify instance
    this.server = Fastify({
      logger: true
    });

    // Register CORS plugin with localhost-only configuration
    this.server.register(fastifyCors, {
      origin: ["http://localhost:8221", "http://127.0.0.1:8221"],
      methods: ["GET", "PUT", "POST", "DELETE", "OPTIONS"],
      credentials: true,
    });

    this.setupRoutes();
    this.setupStaticFiles();
  }

  /**
   * Sets up the API routes
   */
  private setupRoutes(): void {
    // API Routes
    // Get all boards
    this.server.get(
      "/api/boards",
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const boards = this.kanbanDB.getAllBoards();
          return reply.code(200).send(boards);
        } catch (error) {
          request.log.error(error);
          return reply.code(500).send({ error: "Internal Server Error" });
        }
      }
    );

    // Get a specific board with its columns and tasks
    this.server.get(
      "/api/boards/:boardId",
      async (
        request: FastifyRequest<{ Params: { boardId: string } }>,
        reply: FastifyReply
      ) => {
        try {
          const { boardId } = request.params;
          const boardData = this.kanbanDB.getBoardWithColumnsAndTasks(boardId);

          if (!boardData) {
            return reply.code(404).send({ error: "Board not found" });
          }

          return reply.code(200).send(boardData);
        } catch (error) {
          request.log.error(error);
          return reply.code(500).send({ error: "Internal Server Error" });
        }
      }
    );

    // Delete a board and all its related data
    this.server.delete(
      "/api/boards/:boardId",
      async (
        request: FastifyRequest<{ Params: { boardId: string } }>,
        reply: FastifyReply
      ) => {
        try {
          const { boardId } = request.params;
          
          // Check if board exists
          const board = this.kanbanDB.getBoardById(boardId);
          if (!board) {
            return reply.code(404).send({ error: "Board not found" });
          }
          
          // Delete the board and all related data
          const changes = this.kanbanDB.deleteBoard(boardId);
          
          return reply.code(200).send({ 
            success: true,
            message: "Board deleted successfully",
            boardId,
            changes
          });
        } catch (error) {
          request.log.error(error);
          return reply.code(500).send({ error: "Internal Server Error" });
        }
      }
    );

    // Get the task full info and content
    this.server.get(
      "/api/tasks/:taskId",
      async (
        request: FastifyRequest<{ Params: { taskId: string } }>,
        reply: FastifyReply
      ) => {
        try {
          const { taskId } = request.params;
          const task = this.kanbanDB.getTaskById(taskId);

          if (!task) {
            return reply.code(404).send({ error: "Task not found" });
          }

          return reply.code(200).send(task);
        } catch (error) {
          request.log.error(error);
          return reply.code(500).send({ error: "Internal Server Error" });
        }
      }
    );

    // Update a task's content
    this.server.put(
      "/api/tasks/:taskId",
      async (
        request: FastifyRequest<{
          Params: { taskId: string };
          Body: { content: string };
        }>,
        reply: FastifyReply
      ) => {
        try {
          const { taskId } = request.params;
          const { content } = request.body as { content: string };
          
          // Check if task exists
          const task = this.kanbanDB.getTaskById(taskId);
          if (!task) {
            return reply.code(404).send({ error: "Task not found" });
          }
          
          // Update the task
          const updatedTask = this.kanbanDB.updateTask(taskId, content);
          
          // Return success response
          return reply.code(200).send({ 
            success: true,
            message: "Task updated successfully",
            task: updatedTask
          });
        } catch (error) {
          request.log.error(error);
          return reply.code(500).send({ error: "Internal Server Error" });
        }
      }
    );

    // Move a task to a different column
    this.server.post(
      "/api/tasks/:taskId/move",
      async (
        request: FastifyRequest<{
          Params: { taskId: string };
          Body: { targetColumnId: string; reason?: string };
        }>,
        reply: FastifyReply
      ) => {
        try {
          const { taskId } = request.params;
          const { targetColumnId, reason } = request.body as { targetColumnId: string; reason?: string };
          
          // Check if task exists
          const task = this.kanbanDB.getTaskById(taskId);
          if (!task) {
            return reply.code(404).send({ error: "Task not found" });
          }
          
          // Check if target column exists
          const targetColumn = this.kanbanDB.getColumnById(targetColumnId);
          if (!targetColumn) {
            return reply.code(404).send({ error: "Target column not found" });
          }
          
          try {
            // Move the task
            this.kanbanDB.moveTask(taskId, targetColumnId, reason);
            
            // Return success response
            return reply.code(200).send({ 
              success: true,
              message: "Task moved successfully",
              taskId,
              sourceColumnId: task.column_id,
              targetColumnId
            });
          } catch (error) {
            // Handle WIP limit error
            if (error instanceof ColumnCapacityFullError) {
              return reply.code(422).send({ 
                error: "Column capacity full",
                message: (error as Error).message
              });
            }
            throw error;
          }
        } catch (error) {
          request.log.error(error);
          return reply.code(500).send({ error: "Internal Server Error" });
        }
      }
    );

    // handle 404 by redirecting to /
    this.server.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      reply.redirect("/");
    });
  }

  /**
   * Sets up the static file serving
   */
  private setupStaticFiles(): void {
    // Serve static files for the React app
    this.server.register(fastifyStatic, {
      root: path.join(__dirname, "../../../web-ui/dist"),
      prefix: "/"
    });
  }

  /**
   * Starts the web server
   */
  async start(): Promise<void> {
    try {
      const host = process.env.KANBAN_WEB_HOST ?? "localhost";
      const port = Number(process.env.KANBAN_WEB_PORT ?? 8221);
      await this.server.listen({ port, host });
      console.log(`Server is running at http://${host}:${port}`);
    } catch (err) {
      this.server.log.error(err);
      process.exit(1);
    }
  }

  /**
   * Closes the web server
   */
  async close(): Promise<void> {
    await this.server.close();
  }

  /**
   * Gets the server instance
   */
  getServer(): FastifyInstance {
    return this.server;
  }
}

// Create a function to start the web server
const start = async (kanbanDB: KanbanDB): Promise<WebServer> => {
  const webServer = new WebServer(kanbanDB);
  await webServer.start();
  return webServer;
};

// Export the WebServer class and start function
export { WebServer, start };
