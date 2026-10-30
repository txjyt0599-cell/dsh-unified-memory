import zstandard as zstd
import io, json, sys, glob, re

# 锁死 UTF-8 输出，杜绝 Windows 控制台代码页乱码
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "status": "backend_error",
            "matches": 0,
            "snippets": [],
            "truncated": False,
            "error": "insufficient arguments"
        }, ensure_ascii=False))
        return

    sid = sys.argv[1].strip()
    pat = sys.argv[2].strip()
    max_n = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    max_c = int(sys.argv[4]) if len(sys.argv) > 4 else 800

    if not sid:
        print(json.dumps({
            "status": "not_found",
            "sessionId": "",
            "matches": 0,
            "snippets": [],
            "truncated": False,
            "error": "empty sessionId"
        }, ensure_ascii=False))
        return

    try:
        reg = re.compile(pat, re.IGNORECASE)
    except Exception:
        reg = re.compile(re.escape(pat), re.IGNORECASE)

    # 递归查找匹配的 session 归档文件
    #
    # [2026-10-30 · 开源版修复] 原来这里写死 "C:/Users/Administrator/.dsh/sessions" ——
    #   换台机器、换个用户名这条通道就永远 not_found，而且**静默**（调用方只拿到 no_match，
    #   看起来像"这张卡没有原始对话"，实际是路径根本没找对地方）。
    #   ⇒ 由调用方把 sessions 根目录作为 argv[5] 传进来；没传就退回 ~/.dsh/sessions。
    import os
    sessions_root = sys.argv[5].strip() if len(sys.argv) > 5 and sys.argv[5].strip() else os.path.join(
        os.path.expanduser("~"), ".dsh", "sessions"
    )
    sessions_root = sessions_root.replace("\\", "/").rstrip("/")
    matches = glob.glob(sessions_root + "/**/" + sid + "*/session.v4.jsonl.zstd", recursive=True)
    if not matches:
        matches = glob.glob(sessions_root + "/**/*" + sid + "*/session.v4.jsonl.zstd", recursive=True)

    candidate_truncated = len(matches) > 3

    if not matches:
        print(json.dumps({
            "status": "not_found",
            "sessionId": sid,
            "matches": 0,
            "snippets": [],
            "truncated": False,
            "error": "session archive file not found"
        }, ensure_ascii=False))
        return

    found = []
    first_error = None
    target_path = None
    has_truncated = False

    for candidate in matches[:3]:
        if len(found) >= max_n:
            break
        try:
            with open(candidate, "rb") as f:
                dctx = zstd.ZstdDecompressor()
                stream_reader = dctx.stream_reader(f)
                text_stream = io.TextIOWrapper(stream_reader, encoding="utf-8", errors="ignore")
                target_path = candidate
                
                for line in text_stream:
                    if not line.strip():
                        continue
                    # 单行保护（最大 1MB）
                    if len(line) > 1024 * 1024:
                        line = line[:1024 * 1024]
                    try:
                        ev = json.loads(line)
                        msg = ev.get("data", {}).get("message") or ev.get("message")
                        if msg:
                            role = msg.get("role", "unknown")
                            content = msg.get("content")
                            if isinstance(content, list):
                                content = "".join([c.get("text", "") for c in content if isinstance(c, dict)])
                            if content and reg.search(content):
                                role_name = "主人" if role == "user" else "菲比"
                                if len(content) > max_c:
                                    has_truncated = True
                                    cut = content[:max_c] + " ...[余下截断]"
                                else:
                                    cut = content
                                found.append(f"[{role_name}原话] {cut}")
                                if len(found) >= max_n:
                                    break
                    except Exception:
                        pass
        except Exception as e:
            if not first_error:
                first_error = str(e)

    if first_error and not found:
        print(json.dumps({
            "status": "backend_error",
            "sessionId": sid,
            "file": target_path or matches[0],
            "matches": 0,
            "snippets": [],
            "truncated": False,
            "error": first_error
        }, ensure_ascii=False))
        return

    status = "hit" if found else "no_match"
    print(json.dumps({
        "status": status,
        "sessionId": sid,
        "file": target_path or matches[0],
        "matches": len(found),
        "snippets": found,
        "truncated": has_truncated,
        "candidateTruncated": candidate_truncated,
        "error": None
    }, ensure_ascii=False))

if __name__ == '__main__':
    main()
