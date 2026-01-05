// PM2 Configuration for Zight Webhook Server
// Usage: pm2 start ecosystem.config.cjs

module.exports = {
  apps: [
    {
      name: "zight-webhook",
      script: "./webhook-server.js",
      instances: 1,
      exec_mode: "fork",
      interpreter: "node",
      watch: false,
      env: {
        NODE_ENV: "production",
        WEBHOOK_PORT: 3000,
        WEBHOOK_API_KEY: "zight-webhook-2026",
        BROWSERBASE_ENABLED: "false",
        HEADLESS: "true",
      },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "500M",
    },
  ],
};

