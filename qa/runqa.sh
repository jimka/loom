#!/bin/bash
# One WebKitGTK (MiniBrowser) measurement run of the real Loom shell.
#   usage: qa/runqa.sh <name> <main|wt> [extra-query-params]
#
# Points Loom's @jimka/typescript-ui symlink at the library build under test,
# (re)starts Vite on the QA config so it re-resolves the package, drives one
# harness scenario in a full-screen MiniBrowser window, then stops Vite and
# restores the symlink to the main checkout. Prints the result file, or exits 1
# with NO RESULT if the run wrote none. See README.md.
#
#   main   the library checkout Loom normally uses (QA_MAIN_LIB, default
#          ../typescript-ui/packages/lib beside this repo)
#   wt     another build to compare against it, e.g. a worktree's
#          packages/lib (QA_WT_LIB, required for this arm)
#
# Kills Vite by port, never with pkill -f — that matched the calling shell once.
set -u
QA=$(cd "$(dirname "$0")" && pwd)
LOOM=$(dirname "$QA")
MAIN_LIB=$(realpath "${QA_MAIN_LIB:-$LOOM/../typescript-ui/packages/lib}")
MINIBROWSER=${QA_MINIBROWSER:-/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser}
LINK="$LOOM/node_modules/@jimka/typescript-ui"

name=$1; which=$2; extra=${3:-}

if [ "$which" = wt ]; then
    if [ -z "${QA_WT_LIB:-}" ]; then
        echo "[$name] the wt arm needs QA_WT_LIB set to a built packages/lib" >&2
        exit 2
    fi
    lib=$(realpath "$QA_WT_LIB")
else
    lib=$MAIN_LIB
fi

if [ ! -d "$lib/dist/lib" ]; then
    echo "[$name] no build at $lib/dist/lib — build the library first" >&2
    exit 2
fi

kill_vite() {
    for pid in $(ss -ltnp 2>/dev/null | awk '/:1420 /' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
        kill "$pid" 2>/dev/null
    done
    sleep 1
}

# Leave Loom pointing at the main checkout however the run ends, so a sweep
# never strands it on the last arm's build.
cleanup() {
    kill_vite
    ln -sfn "$MAIN_LIB" "$LINK"
    rm -f "$marker"
}

marker=$(mktemp)
trap cleanup EXIT
mkdir -p "$QA/logs" "$QA/results"

ln -sfn "$lib" "$LINK"

# The main arm imports the library by its bare specifier, exactly as the app
# does. The wt arm also names the build's dist directory, so the harness loads
# the same module instance the re-pointed symlink gives the app.
query="qa=$name"
if [ "$which" = wt ]; then
    libparam=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "/@fs$lib/dist/lib")
    query="$query&lib=$libparam"
fi

kill_vite
(cd "$LOOM" && npx vite --config qa/vite.config.qa.ts > "$QA/logs/vite-$name.log" 2>&1 &)
for _ in $(seq 1 80); do
    curl -sf -o /dev/null http://localhost:1420/ && break
    sleep 0.5
done

url="http://localhost:1420/?$query${extra:+&$extra}"
echo "[$name] $which -> $url"
timeout "${QA_TIMEOUT:-55}" "$MINIBROWSER" --full-screen "$url" >/dev/null 2>&1

result=$(find "$QA/results" -name "$name-*.json" -newer "$marker" | sort | tail -1)
if [ -z "$result" ]; then
    echo "[$name] NO RESULT — see $QA/logs/vite-$name.log" >&2
    exit 1
fi
echo "$result"
