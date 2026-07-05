"""Replicates Mien's youtube.fetcher caption pipeline to pull a transcript.
Watch page -> ytInitialPlayerResponse caption tracks, falling back to the
InnerTube ANDROID player endpoint (same path the app uses)."""
import json, re, sys, urllib.parse, urllib.request

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/atom+xml,application/xml,text/xml,text/html,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}
INNERTUBE_CONTEXT = {"client": {"clientName": "ANDROID", "clientVersion": "20.10.38"}}


def get(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or HEADERS,
                                 method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("utf-8", "replace")


def video_id(u):
    m = re.search(r"(?:v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})", u)
    return m.group(1) if m else None


def extract_player_response(html):
    for marker in ("ytInitialPlayerResponse =", "var ytInitialPlayerResponse ="):
        i = html.find(marker)
        if i == -1:
            continue
        i += len(marker)
        depth = 0
        start = html.find("{", i)
        for j in range(start, len(html)):
            c = html[j]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(html[start:j + 1])
                    except Exception:
                        break
    return None


def tracks_from(pr):
    try:
        return pr["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]
    except (KeyError, TypeError):
        return []


def choose(tracks):
    usable = [t for t in tracks if t.get("baseUrl")]
    if not usable:
        return None
    for t in usable:
        if t.get("languageCode", "").lower().startswith("en") and not t.get("kind"):
            return t
    for t in usable:
        if t.get("languageCode", "").lower().startswith("en"):
            return t
    return usable[0]


def with_fmt(base, fmt):
    p = urllib.parse.urlparse(base)
    q = dict(urllib.parse.parse_qsl(p.query))
    q["fmt"] = fmt
    return urllib.parse.urlunparse(p._replace(query=urllib.parse.urlencode(q)))


def parse_json3(raw):
    d = json.loads(raw)
    out = []
    for ev in d.get("events", []):
        for seg in ev.get("segs", []):
            out.append(seg.get("utf8", ""))
    return re.sub(r"\s+", " ", "".join(out)).strip()


def parse_xml(raw):
    parts = re.findall(r"<text[^>]*>([\s\S]*?)</text>", raw)
    import html as _h
    return re.sub(r"\s+", " ", " ".join(_h.unescape(p.replace("\n", " ")) for p in parts)).strip()


def main(url):
    vid = video_id(url)
    html = get(f"https://www.youtube.com/watch?v={vid}")
    tracks = tracks_from(extract_player_response(html) or {})
    if not tracks:
        m = re.search(r'"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"', html)
        if m:
            body = json.dumps({"context": INNERTUBE_CONTEXT, "videoId": vid}).encode()
            h = {**HEADERS, "Content-Type": "application/json"}
            data = json.loads(get(f"https://www.youtube.com/youtubei/v1/player?key={m.group(1)}", body, h))
            tracks = tracks_from(data)
    print(f"tracks={[(t.get('languageCode'), t.get('kind')) for t in tracks]}", file=sys.stderr)
    track = choose(tracks)
    if not track:
        print("NO_TRACKS", file=sys.stderr)
        sys.exit(2)
    raw = get(with_fmt(track["baseUrl"], "json3"))
    print(f"json3 len={len(raw)}", file=sys.stderr)
    text = ""
    if raw.strip():
        try:
            text = parse_json3(raw)
        except Exception as e:
            print(f"json3 parse err: {e}", file=sys.stderr)
    if not text:
        raw = get(with_fmt(track["baseUrl"], "srv3"))
        print(f"srv3 len={len(raw)}", file=sys.stderr)
        text = parse_xml(raw)
    if not text:
        # last resort: raw baseUrl with no fmt (default XML)
        raw = get(track["baseUrl"])
        print(f"raw len={len(raw)}", file=sys.stderr)
        text = parse_xml(raw)
    sys.stdout.buffer.write(text.encode("utf-8"))


if __name__ == "__main__":
    main(sys.argv[1])
