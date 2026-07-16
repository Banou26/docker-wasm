FROM alpine:3.19

EXPOSE 8080
CMD ["/bin/sh","-c","printf '%s\\n' '#!/bin/sh' 'while IFS= read -r line; do [ \"$line\" = \"$(printf \"\\r\")\" ] && break; done' 'echo '\"'\"'[http] request received'\"'\"' >&2' 'printf '\"'\"'HTTP/1.0 200 OK\\r\\nContent-Type: application/json; charset=utf-8\\r\\nContent-Length: 112\\r\\nConnection: close\\r\\n\\r\\n{\"ok\":true,\"message\":\"Hello from inside the Docker image.\",\"service\":\"guest:8080\",\"transport\":\"FKN virtual TCP\"}'\"'\"'' > /tmp/fkn-http-serve && chmod +x /tmp/fkn-http-serve && echo '[http] listening on 0.0.0.0:8080' && exec /bin/busybox nc -lk -p 8080 -e /tmp/fkn-http-serve"]
