import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@polysignal/types": path.resolve(__dirname, "packages/types/src/index.ts"),
      "@polysignal/utils": path.resolve(__dirname, "packages/utils/src/index.ts"),
      "@polysignal/data": path.resolve(__dirname, "packages/data/src/index.ts"),
      "@polysignal/book": path.resolve(__dirname, "packages/book/src/index.ts"),
      "@polysignal/features": path.resolve(__dirname, "packages/features/src/index.ts"),
      "@polysignal/storage": path.resolve(__dirname, "packages/storage/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Fix for tinypool stack overflow during worker cleanup
    // Use forks pool with single fork to avoid tinypool cleanup recursion bug
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true, // Run everything in a single fork (sequential)
      },
    },
    fileParallelism: false, // Disable file-level parallelism
  },
  server: {
    deps: {
      external: ["better-sqlite3"]
    }
  },
  deps: {
    optimizer: {
      ssr: {
        exclude: ["better-sqlite3"]
      }
    }
  },
  ssr: {
    external: ["better-sqlite3"]
  }
});
