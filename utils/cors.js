const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://154.19.187.78:3000",
  "http://154.19.187.78:3001",
];

const allowedOriginsFromEnv = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins =
  process.env.NODE_ENV === "production"
    ? allowedOriginsFromEnv.length > 0
      ? allowedOriginsFromEnv
      : defaultAllowedOrigins
    : defaultAllowedOrigins;

const getAllowedOrigin = (origin) => {
  if (!origin) return null;
  return allowedOrigins.includes(origin) ? origin : null;
};

module.exports = {
  allowedOrigins,
  getAllowedOrigin,
};
