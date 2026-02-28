module.exports = {
  apps: [
    {
      name: "vagus-relay",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: "10s",
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: "production",
        PORT: 18087,
        TRUST_PROXY: "true",
        REQUIRE_ORIGIN: "false"
      }
    }
  ]
};

