"""Exact Darwin process inspection. Never emits the raw process environment.

Only the guard uses this helper's JSON; public diagnostics stay generic.
Unsupported platforms, permissions, and ambiguous kernel observations fail closed.
"""

import ctypes
import errno
import json
import os
import struct
import subprocess
import sys


CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ENV_KEYS = {
    "NODE_OPTIONS",
    "HERDR_ENV", "HERDR_SESSION", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID",
    "CHROME_DEVTOOLS_AXI_SESSION", "CHROME_DEVTOOLS_AXI_PORT", "CHROME_DEVTOOLS_AXI_MCP_PATH",
    "CHROME_DEVTOOLS_AXI_BROWSER_URL", "DOTFILES_BROWSER_POLICY_SESSION",
    "DOTFILES_BROWSER_POLICY_REPO_SHA256", "DOTFILES_BROWSER_POLICY_VERSION",
    "DOTFILES_BROWSER_POLICY_ALLOCATION", "DOTFILES_BROWSER_POLICY_MODE",
}


class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid",
        "svuid", "svgid", "rfu",
    )] + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid")
    ] + [("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]


# Static-width Darwin proc_info.h structures for PROC_PIDVNODEPATHINFO.
# Reading cwd through libproc avoids invoking a global lsof scan for each PID.
class VinfoStat(ctypes.Structure):
    _fields_ = [("dev", ctypes.c_uint32), ("mode", ctypes.c_uint16),
                ("nlink", ctypes.c_uint16), ("ino", ctypes.c_uint64),
                ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32)] + [
        (name, ctypes.c_int64) for name in ("atime", "atimensec", "mtime", "mtimensec",
                                          "ctime", "ctimensec", "birthtime", "birthtimensec", "size", "blocks")
    ] + [("blksize", ctypes.c_int32), ("flags", ctypes.c_uint32),
         ("gen", ctypes.c_uint32), ("rdev", ctypes.c_uint32), ("qspare", ctypes.c_int64 * 2)]


class VnodeInfo(ctypes.Structure):
    _fields_ = [("stat", VinfoStat), ("type", ctypes.c_int32),
                ("pad", ctypes.c_int32), ("fsid", ctypes.c_int32 * 2)]


class VnodePath(ctypes.Structure):
    _fields_ = [("info", VnodeInfo), ("path", ctypes.c_char * 1024)]


class VnodePaths(ctypes.Structure):
    _fields_ = [("cwd", VnodePath), ("root", VnodePath)]


def control_name(name):
    return name.startswith(("CHROME_DEVTOOLS_AXI_", "DOTFILES_BROWSER_POLICY_",
                            "CHROME_DEVTOOLS_MCP_", "PUPPETEER_", "PLAYWRIGHT_")) or name in {
        "NODE_OPTIONS", "NODE_PATH", "DEBUG", "NODE_DEBUG", "BROWSER", "CHROME_BIN",
        "CHROMIUM_BIN", "GOOGLE_CHROME_SHIM", "CHROME_PATH", "CHROME_EXECUTABLE",
    } or name.lower().startswith("npm_config_")


def parse_procargs(data):
    """KERN_PROCARGS2 is argc, executable NUL padding, argv NULs, then env.

    Decode argv exactly, preserving embedded spaces. Filter environment in this
    process, before serialization, so credentials never reach Node or logs.
    """
    if len(data) < 5:
        raise ValueError("short process arguments")
    argc = struct.unpack_from("=i", data)[0]
    if not 1 <= argc <= 8192:
        raise ValueError("invalid argc")
    offset = data.index(b"\0", 4) + 1
    while offset < len(data) and data[offset] == 0:
        offset += 1
    argv = []
    for _ in range(argc):
        end = data.index(b"\0", offset)
        argv.append(data[offset:end].decode("utf-8", "strict"))
        offset = end + 1
    env = {}
    names = []
    for token in data[offset:].split(b"\0"):
        if b"=" not in token:
            continue
        name_bytes, value = token.split(b"=", 1)
        name = name_bytes.decode("ascii", "strict")
        if control_name(name):
            names.append(name)
        if name in ENV_KEYS:
            env[name] = value.decode("utf-8", "strict")
    return argv, env, names


def command(args, empty_ok=False):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                            timeout=2, check=False)
    if empty_ok and result.returncode == 1 and not result.stdout and not result.stderr:
        return ""
    if result.returncode:
        raise ValueError("inspection command failed")
    return result.stdout.decode("utf-8", "strict")


def kernel():
    if sys.platform != "darwin":
        raise ValueError("Darwin inspection required")
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    proc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                           ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                           ctypes.c_void_p, ctypes.c_size_t]
    proc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                 ctypes.c_void_p, ctypes.c_int]
    proc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    return libc, proc


def inspect_record(pid):
    libc, proc = kernel()
    info = BsdInfo()
    ctypes.set_errno(0)
    size = proc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if size == 0 and ctypes.get_errno() == errno.ESRCH:
        return None
    if size != ctypes.sizeof(info) or info.pid != pid:
        raise ValueError("process identity unavailable")
    if info.status == 5:  # SZOMB: exited, not a connectable or reusable process.
        return None
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    length = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(length), None, 0) or not 0 < length.value <= 2**20:
        raise ValueError("process arguments unavailable")
    data = ctypes.create_string_buffer(length.value)
    if libc.sysctl(mib, 3, data, ctypes.byref(length), None, 0):
        raise ValueError("process arguments changed")
    argv, env, names = parse_procargs(data.raw[:length.value])
    path = ctypes.create_string_buffer(4096)
    if proc.proc_pidpath(pid, path, len(path)) <= 0:
        raise ValueError("process executable unavailable")
    paths = VnodePaths()
    if proc.proc_pidinfo(pid, 9, 0, ctypes.byref(paths), ctypes.sizeof(paths)) != ctypes.sizeof(paths):
        raise ValueError("process cwd unavailable")
    cwd = paths.cwd.path.decode("utf-8", "strict")
    if not cwd.startswith("/"):
        raise ValueError("process cwd unsupported")
    # Recheck microsecond start identity after the argv/path queries.
    after = BsdInfo()
    if proc.proc_pidinfo(pid, 3, 0, ctypes.byref(after), ctypes.sizeof(after)) != ctypes.sizeof(after) or (
        after.start_sec, after.start_usec, after.uid, after.ruid
    ) != (info.start_sec, info.start_usec, info.uid, info.ruid):
        raise ValueError("process changed")
    if info.uid != info.ruid:
        raise ValueError("setuid process unsupported")
    return {"pid": pid, "ppid": info.ppid, "uid": info.uid, "pgid": info.pgid,
            "tpgid": info.tpgid, "start": f"{info.start_sec}:{info.start_usec}",
            "exe": os.path.realpath(path.value.decode()), "cwd": os.path.realpath(cwd),
            "argv": argv, "env": env, "controlNames": names}


def record(pid):
    try:
        return inspect_record(pid)
    except Exception:
        # Exit during argv/cwd inspection is different from an inaccessible or
        # reused live process. Only a fresh kernel absence/zombie proves exit.
        _, proc = kernel()
        info = BsdInfo()
        ctypes.set_errno(0)
        size = proc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if (size == 0 and ctypes.get_errno() == errno.ESRCH) or (
            size == ctypes.sizeof(info) and info.status == 5
        ):
            return None
        raise


def live_info(proc, pid):
    """Fresh kernel observation; unreadable identity is never absence."""
    info = BsdInfo()
    ctypes.set_errno(0)
    size = proc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if size == 0 and ctypes.get_errno() == errno.ESRCH:
        return None
    if size != ctypes.sizeof(info) or info.pid != pid:
        raise ValueError("process identity unavailable")
    if info.status == 5:
        return None
    return info


def listeners(port):
    kernel()
    output = command(["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fpn"], empty_ok=True)
    result = []
    pid = None
    for line in output.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n"):
            if pid is None:
                raise ValueError("listener PID missing")
            result.append({"pid": pid, "address": line[1:]})
    return result


def profile_users(profile):
    libc, proc = kernel()
    count = proc.proc_listallpids(None, 0)
    if count <= 0:
        raise ValueError("process inventory unavailable")
    pids = (ctypes.c_int * (count + 1024))()
    actual = proc.proc_listallpids(pids, ctypes.sizeof(pids))
    if actual <= 0 or actual >= len(pids):
        raise ValueError("process inventory changed")
    users = []
    for pid in pids[:actual]:
        try:
            info = live_info(proc, pid)
            if info is None or info.uid != os.getuid():
                continue
            # Query only same-UID argv in memory; never emit another process's argv.
            mib = (ctypes.c_int * 3)(1, 49, pid)
            length = ctypes.c_size_t()
            if libc.sysctl(mib, 3, None, ctypes.byref(length), None, 0):
                raise ValueError("process inventory incomplete")
            if not 0 < length.value <= 2**20:
                raise ValueError("process inventory unsupported")
            data = ctypes.create_string_buffer(length.value)
            if libc.sysctl(mib, 3, data, ctypes.byref(length), None, 0):
                raise ValueError("process inventory changed")
            argv, _, _ = parse_procargs(data.raw[:length.value])
            after = live_info(proc, pid)
            if after is None:
                continue
            if (after.start_sec, after.start_usec, after.uid, after.ruid) != (
                info.start_sec, info.start_usec, info.uid, info.ruid
            ):
                raise ValueError("process inventory identity changed")
        except Exception:
            # A PID can exit during inspection. Re-probe before accepting that
            # explanation; a live unreadable/reused PID keeps ownership unknown.
            if live_info(proc, pid) is None:
                continue
            raise ValueError("process inventory incomplete")
        if any(arg.startswith("--user-data-dir=") and os.path.realpath(arg.split("=", 1)[1]) == profile for arg in argv) or any(
            arg == "--user-data-dir" and i + 1 < len(argv) and os.path.realpath(argv[i + 1]) == profile
            for i, arg in enumerate(argv)
        ):
            users.append(pid)
    return users


def main(args):
    operation = args[0]
    if operation == "herdr":
        kernel()
        path = os.path.realpath("/opt/homebrew/bin/herdr")
        stat = os.stat(path)
        if not os.path.isfile(path) or stat.st_uid not in (0, os.getuid()) or stat.st_mode & 0o022:
            raise ValueError("untrusted Herdr metadata executable")
        return json.loads(command([path, "--session", args[1], *args[2:]]) )["result"]
    if operation == "record":
        return record(int(args[1]))
    if operation == "listeners":
        return listeners(int(args[1]))
    if operation == "children":
        kernel()
        return [int(pid) for pid in command(["/usr/bin/pgrep", "-P", args[1]], empty_ok=True).split()]
    if operation == "profile-users":
        return profile_users(args[1])
    if operation == "trusted-chrome":
        kernel()
        stat = os.stat(CHROME)
        if (os.path.realpath(CHROME) != CHROME or not os.path.isfile(CHROME)
                or stat.st_uid not in (0, os.getuid()) or stat.st_mode & 0o002
                or (stat.st_mode & 0o020 and stat.st_gid not in (0, 80))):
            raise ValueError("untrusted Chrome executable")
        # macOS casks commonly grant admin-group writes (gid 80).
        # Verify the signed bundle without mutating its installation: --strict
        # also rejects harmless Finder metadata, and -R needs '=' for inline text.
        command(["/usr/bin/codesign", "--verify", "-R",
                 '=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"',
                 "/Applications/Google Chrome.app"])
        return True
    raise ValueError("unsupported inspection")


if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv[1:])))
    except Exception:
        sys.stderr.write("browser process inspection unavailable\n")
        sys.exit(78)
