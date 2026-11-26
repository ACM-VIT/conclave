import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import type Docker from "dockerode";
import { VNC_AUTH_IMAGE_LABEL, VNC_AUTH_IMAGE_LABEL_VALUE } from "../../src/ContainerManager.js";

export type Image = { Labels: Record<string, string>; Id?: string } | null;

export const hardenedImage: Image = { Labels: { [VNC_AUTH_IMAGE_LABEL]: VNC_AUTH_IMAGE_LABEL_VALUE } };

export const fakeDocker = <Created>(image: Image, created: Created[] = []) =>
    ({
        ping: async () => undefined,
        getImage: () => ({
            inspect: async () => {
                if (!image) throw Object.assign(new Error("(HTTP code 404) no such image"), { statusCode: 404 });
                return { Id: image.Id ?? "sha256:hardened", Config: { Labels: image.Labels } };
            },
        }),
        getContainer: () => ({ remove: async () => undefined, stop: async () => undefined }),
        createContainer: async (options: Created) => {
            created.push(options);
            return { id: `container-${created.length}`, start: async () => undefined, remove: async () => undefined };
        },
    }) as unknown as Docker;

export const listenHttp = async (server: Server): Promise<number> => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
};

export const fakeDockerEngine = async (images: Record<string, Image>) => {
    const server = createServer((req, res) => {
        const path = (req.url ?? "").replace(/^\/v[\d.]+/, "").split("?")[0];
        if (path === "/_ping") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("OK");
            return;
        }
        const match = path.match(/^\/images\/(.+)\/json$/);
        const image = match ? images[decodeURIComponent(match[1])] : undefined;
        if (!image) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ message: "No such image" }));
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Id: "sha256:test", Config: { Labels: image.Labels } }));
    });
    const port = await listenHttp(server);
    return {
        host: `tcp://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
};

export const freePort = async (): Promise<number> => {
    const probe = createNetServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
};
