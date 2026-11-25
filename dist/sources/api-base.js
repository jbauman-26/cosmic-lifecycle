import { CliError } from '../errors.js';
// Where a built-in source sends its calls. LIFECYCLE_<SOURCE>_API_URL points one source at a
// stand-in on this machine, so the whole CLI (connect, sync, reconcile) can run end to end
// against recorded answers with no real account. Only a loopback address is accepted: a key is
// never sent anywhere but the vendor or this machine, whatever the environment says.
export function apiBase(source, real, env = process.env) {
    const name = `LIFECYCLE_${source.toUpperCase()}_API_URL`;
    const v = env[name]?.trim();
    if (!v)
        return real;
    let u = null;
    try {
        u = new URL(v);
    }
    catch {
        u = null;
    }
    if (!u || u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
        throw new CliError(`${name} must be an http address on this machine, such as http://127.0.0.1:4010.`, `Unset ${name} to use the real API.`, 'bad_url');
    }
    return v.replace(/\/+$/, '');
}
