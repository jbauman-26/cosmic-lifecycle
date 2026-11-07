// Every failure tells the user or agent the exact next step.
export class CliError extends Error {
    next;
    code;
    constructor(message, next, code = 'error') {
        super(message);
        this.next = next;
        this.code = code;
    }
}
