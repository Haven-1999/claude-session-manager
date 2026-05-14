#!/usr/bin/env python3
"""PTY proxy: creates a real PTY, runs a command inside it, and proxies I/O via stdin/stdout.
Used as a fallback when node-pty doesn't work (e.g. macOS 26+)."""

import sys, os, pty, select, signal, struct, fcntl, termios, errno

RESIZE_PREFIX = b'\x1b]9999;'
RESIZE_SUFFIX = b'\x07'

def set_winsize(fd, rows, cols):
    try:
        s = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, s)
    except:
        pass

def main():
    if len(sys.argv) < 2:
        sys.exit(1)

    cols = int(os.environ.get('COLUMNS', '120'))
    rows = int(os.environ.get('LINES', '30'))

    master_fd, slave_fd = pty.openpty()
    set_winsize(master_fd, rows, cols)

    pid = os.fork()
    if pid == 0:
        # Child
        os.close(master_fd)
        os.setsid()

        # Set slave as controlling terminal
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        os.execvp(sys.argv[1], sys.argv[1:])
        os._exit(127)

    # Parent
    os.close(slave_fd)

    # Make stdin non-blocking
    stdin_fd = sys.stdin.fileno()
    flags = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
    fcntl.fcntl(stdin_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    signal.signal(signal.SIGWINCH, signal.SIG_IGN)

    # Forward SIGINT/SIGTERM to child
    def forward_signal(signum, frame):
        try:
            os.kill(pid, signum)
        except:
            pass
    signal.signal(signal.SIGINT, forward_signal)
    signal.signal(signal.SIGTERM, forward_signal)

    stdout_fd = sys.stdout.fileno()
    exit_code = 0
    stdin_buffer = b''

    try:
        while True:
            try:
                fds = [master_fd, stdin_fd]
                r, _, _ = select.select(fds, [], [], 0.1)
            except (select.error, ValueError, OSError) as e:
                if hasattr(e, 'errno') and e.errno == errno.EINTR:
                    continue
                break

            if master_fd in r:
                try:
                    data = os.read(master_fd, 65536)
                    if not data:
                        break
                    os.write(stdout_fd, data)
                except OSError:
                    break

            if stdin_fd in r:
                try:
                    chunk = os.read(stdin_fd, 65536)
                    if not chunk:
                        break
                    stdin_buffer += chunk
                    # Process all complete resize sequences
                    while True:
                        start = stdin_buffer.find(RESIZE_PREFIX)
                        if start == -1:
                            # No resize prefix; forward entire buffer
                            if stdin_buffer:
                                os.write(master_fd, stdin_buffer)
                                stdin_buffer = b''
                            break
                        end = stdin_buffer.find(RESIZE_SUFFIX, start + len(RESIZE_PREFIX))
                        if end == -1:
                            # Incomplete sequence; forward bytes before it, keep the rest
                            if start > 0:
                                os.write(master_fd, stdin_buffer[:start])
                                stdin_buffer = stdin_buffer[start:]
                            break
                        # Forward any bytes before the sequence
                        if start > 0:
                            os.write(master_fd, stdin_buffer[:start])
                        # Extract payload before removing from buffer
                        payload = stdin_buffer[start + len(RESIZE_PREFIX):end]
                        stdin_buffer = stdin_buffer[end + len(RESIZE_SUFFIX):]
                        # Parse and apply resize
                        try:
                            dims = payload.decode('ascii')
                            c, r_val = dims.split('x')
                            new_cols, new_rows = int(c), int(r_val)
                            set_winsize(master_fd, new_rows, new_cols)
                            os.kill(pid, signal.SIGWINCH)
                        except (ValueError, OSError):
                            pass
                except OSError as e:
                    if e.errno == errno.EAGAIN:
                        continue
                    break

            # Check if child is still alive
            result = os.waitpid(pid, os.WNOHANG)
            if result[0] != 0:
                exit_code = os.WEXITSTATUS(result[1]) if os.WIFEXITED(result[1]) else 1
                # Drain remaining output
                try:
                    while True:
                        data = os.read(master_fd, 65536)
                        if not data:
                            break
                        os.write(stdout_fd, data)
                except:
                    pass
                break
    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.close(master_fd)
        except:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except:
            pass

    sys.exit(exit_code)

if __name__ == '__main__':
    main()
