mkdir -p dist
docker build -t docker-wasm .
docker create -ti --name docker-wasm-container docker-wasm
docker cp docker-wasm-container:/build/dist/. dist/
docker rm -fv docker-wasm-container
