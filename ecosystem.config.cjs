module.exports = {
  apps: [
    {
      name: "ledgerly-backend",
      cwd: "./backend",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "3004",
        JWT_SECRET: "", // ← Set this to a strong random value!
        DATABASE_URL: "./data/ledgerly.db",
        ADMIN_EMAIL: "", // ← Set to seed an admin user on first boot (e.g. "admin@example.com")
        ADMIN_PASSWORD: "", // ← Set alongside ADMIN_EMAIL (min 6 chars)
        FRONTEND_URL: "https://excel.frillchills.com",
        PUBLIC_API_BASE_URL: "https://excel.frillchills.com/api",
        XERO_REDIRECT_URI: "https://excel.frillchills.com/api/xero/callback",
      },
      error_file: "../logs/backend-error.log",
      out_file: "../logs/backend-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
    },
  ],
};
