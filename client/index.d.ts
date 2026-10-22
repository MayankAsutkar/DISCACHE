export interface DisCacheClientOptions {
  /** Coordinator address. Defaults to 127.0.0.1. */
  host?: string;
  /** Coordinator port. Defaults to 8000. */
  port?: number;
  /** Per-request timeout in milliseconds. Defaults to 3000. */
  timeoutMs?: number;
}

/** Error returned when a request fails or the server reports an error status. */
export class DisCacheError extends Error {
  readonly status: number | null;
}

/** Client for the DisCache binary TCP protocol. */
export class DisCacheClient {
  constructor(options?: DisCacheClientOptions);

  /** Returns the cached string, or null when the key is missing. */
  get(key: string): Promise<string | null>;

  /** Stores or replaces a string value. */
  put(key: string, value: string): Promise<void>;

  /** Removes a key and returns whether it existed. */
  delete(key: string): Promise<boolean>;

  /** Checks that the coordinator responds to a PING request. */
  ping(): Promise<boolean>;
}
