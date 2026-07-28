# The demo service the Container Lab homepage talks to.
#
# It answers every request with what it saw: method, path, header count, and the
# machine it is running on. The point of the page is that the JSON in the
# browser was assembled by busybox inside a real Linux guest, so the response
# describes the request rather than repeating a canned string.
#
# The responder is embedded base64 rather than written with RUN, because a RUN
# step would have to execute riscv64 binaries at build time and that needs
# binfmt handlers on the build host. FROM, EXPOSE, COPY and CMD do not.
#
# Decoded, /tmp/serve.sh is:
#
# #!/bin/sh
# # One HTTP request per connection. stdin and stdout are the socket.
# set -u
# read -r request || exit 0
# request=$(printf '%s' "$request" | tr -d '\r')
# method=$(printf '%s' "${request%% *}" | tr -cd 'A-Za-z')
# target=${request#* }
# target=$(printf '%s' "${target%% *}" | tr -d '"\\' | cut -c1-200)
# [ -n "$target" ] || target=/
# headers=0
# agent=""
# while IFS= read -r header; do
#     header=$(printf '%s' "$header" | tr -d '\r')
#     [ -z "$header" ] && break
#     headers=$((headers + 1))
#     case "$header" in
#         [Uu]ser-[Aa]gent:*) agent=$(printf '%s' "${header#*:}" | sed 's/^ *//' | tr -d '"\\' | cut -c1-120) ;;
#     esac
# done
# echo "[container] $method $target" >&2
# body=$(printf '{"ok":true,"method":"%s","path":"%s","requestHeaders":%s,"userAgent":"%s","machine":"%s","kernel":"%s","uptimeSeconds":%s,"servedBy":"busybox sh inside the image"}' \
#     "$method" "$target" "$headers" "$agent" "$(uname -m)" "$(uname -r)" "$(cut -d. -f1 /proc/uptime)")
# length=$(printf '%s' "$body" | wc -c)
# printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "$length" "$body"
FROM alpine:3.21

EXPOSE 8080
CMD ["/bin/sh","-c","echo 'IyEvYmluL3NoCiMgT25lIEhUVFAgcmVxdWVzdCBwZXIgY29ubmVjdGlvbi4gc3RkaW4gYW5kIHN0ZG91dCBhcmUgdGhlIHNvY2tldC4Kc2V0IC11CnJlYWQgLXIgcmVxdWVzdCB8fCBleGl0IDAKcmVxdWVzdD0kKHByaW50ZiAnJXMnICIkcmVxdWVzdCIgfCB0ciAtZCAnXHInKQptZXRob2Q9JChwcmludGYgJyVzJyAiJHtyZXF1ZXN0JSUgKn0iIHwgdHIgLWNkICdBLVphLXonKQp0YXJnZXQ9JHtyZXF1ZXN0IyogfQp0YXJnZXQ9JChwcmludGYgJyVzJyAiJHt0YXJnZXQlJSAqfSIgfCB0ciAtZCAnIlxcJyB8IGN1dCAtYzEtMjAwKQpbIC1uICIkdGFyZ2V0IiBdIHx8IHRhcmdldD0vCmhlYWRlcnM9MAphZ2VudD0iIgp3aGlsZSBJRlM9IHJlYWQgLXIgaGVhZGVyOyBkbwogICAgaGVhZGVyPSQocHJpbnRmICclcycgIiRoZWFkZXIiIHwgdHIgLWQgJ1xyJykKICAgIFsgLXogIiRoZWFkZXIiIF0gJiYgYnJlYWsKICAgIGhlYWRlcnM9JCgoaGVhZGVycyArIDEpKQogICAgY2FzZSAiJGhlYWRlciIgaW4KICAgICAgICBbVXVdc2VyLVtBYV1nZW50OiopIGFnZW50PSQocHJpbnRmICclcycgIiR7aGVhZGVyIyo6fSIgfCBzZWQgJ3MvXiAqLy8nIHwgdHIgLWQgJyJcXCcgfCBjdXQgLWMxLTEyMCkgOzsKICAgIGVzYWMKZG9uZQplY2hvICJbY29udGFpbmVyXSAkbWV0aG9kICR0YXJnZXQiID4mMgpib2R5PSQocHJpbnRmICd7Im9rIjp0cnVlLCJtZXRob2QiOiIlcyIsInBhdGgiOiIlcyIsInJlcXVlc3RIZWFkZXJzIjolcywidXNlckFnZW50IjoiJXMiLCJtYWNoaW5lIjoiJXMiLCJrZXJuZWwiOiIlcyIsInVwdGltZVNlY29uZHMiOiVzLCJzZXJ2ZWRCeSI6ImJ1c3lib3ggc2ggaW5zaWRlIHRoZSBpbWFnZSJ9JyBcCiAgICAiJG1ldGhvZCIgIiR0YXJnZXQiICIkaGVhZGVycyIgIiRhZ2VudCIgIiQodW5hbWUgLW0pIiAiJCh1bmFtZSAtcikiICIkKGN1dCAtZC4gLWYxIC9wcm9jL3VwdGltZSkiKQpsZW5ndGg9JChwcmludGYgJyVzJyAiJGJvZHkiIHwgd2MgLWMpCnByaW50ZiAnSFRUUC8xLjEgMjAwIE9LXHJcbkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvblxyXG5Db250ZW50LUxlbmd0aDogJXNcclxuQ29ubmVjdGlvbjogY2xvc2VcclxuXHJcbiVzJyAiJGxlbmd0aCIgIiRib2R5Igo=' | base64 -d > /tmp/serve.sh && echo '[container] http service listening on 0.0.0.0:8080' >&2 && exec /bin/busybox nc -lk -p 8080 -e /bin/sh /tmp/serve.sh"]
