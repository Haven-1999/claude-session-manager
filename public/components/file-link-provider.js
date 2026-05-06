// Matches absolute Unix paths.
// Supports:
//   /data/repo/src/main.rs
//   /tmp
//   "/path/with spaces/file.txt"
//   '/path/with spaces/file.txt'
const FILE_PATH_REGEX = /(?:^|[^\w\-\/])("(\/[\w\-\.\/\s]+)"|'(\/[\w\-\.\/\s]+)'|(\/\S*?[\w\-\.]+(?:\/[\w\-\.\/]+)?))/g;
export class FileLinkProvider {
    terminal;
    onOpenFile;
    constructor(terminal, onOpenFile) {
        this.terminal = terminal;
        this.onOpenFile = onOpenFile;
    }
    provideLinks(y, callback) {
        const term = this.terminal;
        const line = term.buffer.active.getLine(y - 1);
        if (!line) {
            callback(undefined);
            return;
        }
        const text = line.translateToString(true);
        const links = [];
        let match;
        // Reset regex
        FILE_PATH_REGEX.lastIndex = 0;
        while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
            const fullMatch = match[0];
            // match[2] = double-quoted path, match[3] = single-quoted, match[4] = unquoted
            const path = match[2] || match[3] || match[4];
            if (!path)
                continue;
            const startIndex = match.index + fullMatch.indexOf(path);
            const endIndex = startIndex + path.length;
            const start = { x: startIndex + 1, y };
            const end = { x: endIndex + 1, y };
            links.push({
                text: path,
                range: { start, end },
                activate: (_event, _text) => this.onOpenFile(path),
            });
        }
        callback(links.length > 0 ? links : undefined);
    }
}
