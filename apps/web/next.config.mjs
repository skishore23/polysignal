const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@polysignal/types",
    "@polysignal/utils"
  ],
  serverExternalPackages: ["better-sqlite3", "@polysignal/storage"],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
      config.externals = config.externals || [];
      config.externals.push("better-sqlite3");
    }
    return config;
  },
  experimental: {},
  async headers() {
    // Only allow unsafe-eval in development for Next.js Fast Refresh/HMR
    if (process.env.NODE_ENV === "development") {
      return [
        {
          source: "/:path*",
          headers: [
            {
              key: "Content-Security-Policy",
              value: "script-src 'self' 'unsafe-eval' 'unsafe-inline'; object-src 'none';"
            }
          ]
        }
      ];
    }
    return [];
  }
};

export default nextConfig;
