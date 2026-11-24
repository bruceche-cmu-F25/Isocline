/** A home node whose engine adds one todo and then never finishes, so a test
 * can kill it mid-run. Prints its port when ready.
 */
import { todoModule } from "@isocline/module-todo";
import { createHttpServer, openHome } from "../../src/index.ts";

const home = openHome({
  dataDir: process.argv[2],
  modules: [todoModule],
  engine: {
    async submit(request) {
      await request.tools.find((tool) => tool.name === "todo_add")!.execute({ title: "Written before the crash" }, new AbortController().signal);
      return new Promise(() => {});
    },
  },
});
const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`PORT ${typeof address === "object" && address ? address.port : 0}`);
});
