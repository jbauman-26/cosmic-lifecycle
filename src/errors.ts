// Every failure tells the user or agent the exact next step.
export class CliError extends Error {
  constructor(
    message: string,
    public next: string,
    public code = 'error',
  ) {
    super(message)
  }
}
