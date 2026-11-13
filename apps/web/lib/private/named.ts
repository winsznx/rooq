/** An error with a stable reason code the UI can act on. `retry` says whether trying again can help. */
export class Named extends Error {
  constructor(readonly reason: string, message: string, readonly retry = true) {
    super(message);
  }
}
