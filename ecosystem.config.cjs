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
        FRONTEND_URL: "https://excel.frillchills.com",
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
