import type { Server } from "node:http";
import type { SupervisedEmbeddedPostgres } from "./embedded-postgres-supervisor.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

export type EmbeddedPostgresInstance = SupervisedEmbeddedPostgres & {
  initialise(): Promise<void>;
};

export type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


export interface StartedServer {
  server: Server;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
  shutdown: (signal?: "SIGINT" | "SIGTERM") => Promise<void>;
}

// Set by the boot sequence once the primary pool exists. A boot that fails
// after that point (a bootstrap query that throws, for example) must end the
// pool before the caller exits: the driver keeps idle connections open until
// the process dies, and in a restart loop the leftover backends of every
// failed generation can exhaust `max_connections` before the next boot even
// gets a connection.
export type StartupDatabaseTeardown = { close: (() => Promise<void>) | null };
