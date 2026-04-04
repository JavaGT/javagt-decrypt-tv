import { existsSync } from 'fs';
import { delimiter } from 'path';

export function getBinaryPath(...names) {
    const pathEntries = (process.env.PATH || '').split(delimiter);

    for (const name of names) {
        for (const dir of pathEntries) {
            const candidate = `${dir}/${name}`;
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

export default { getBinaryPath };
