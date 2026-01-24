const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cron = require("node-cron");
const validateEnv = require("./middleware/validateEnv");

// Set timezone for Node.js process (important for Ubuntu servers)
// This ensures all Date operations use the correct timezone
// Sri Lanka Standard Time (SLST) = UTC+5:30
process.env.TZ = process.env.APP_TIMEZONE || "Asia/Colombo";

// Validate environment variables on startup
validateEnv();

const app = express();

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: [
          "'self'",
          "data:",
          "http://localhost:*",
          "http://localhost:5000",
        ],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// CORS configuration - restrict to your frontend domains in production
const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://154.19.187.78:3000",
  "http://154.19.187.78:3001",
];

const allowedOriginsFromEnv = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? allowedOriginsFromEnv.length > 0
        ? allowedOriginsFromEnv
        : defaultAllowedOrigins
      : defaultAllowedOrigins,
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
// Ensure CORS preflight requests are handled for all routes
app.options("*", cors(corsOptions));

// Body parser with size limits
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Serve uploaded images - handle both relative and absolute paths
const fs = require("fs");
// Use the same path resolution as upload middleware
const uploadPath = process.env.UPLOAD_PATH || "./uploads";
const uploadsDir = path.resolve(uploadPath);

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log(`[Server] Created uploads directory: ${uploadsDir}`);
} else {
  console.log(`[Server] Using uploads directory: ${uploadsDir}`);
}

// Helper function to get content type from filename
function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const contentTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return contentTypes[ext] || "application/octet-stream";
}

// Route to serve images by filename (MUST be before static middleware)
app.get("/uploads/:filename", async (req, res) => {
  const filename = req.params.filename;
  // Sanitize filename to prevent directory traversal
  const safeFilename = path.basename(filename);
  const filePath = path.join(uploadsDir, safeFilename);

  // Set CORS headers for image requests (must be set before sending response)
  const origin = req.headers.origin;
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  // Log for debugging
  console.log(`[Image Request] Looking for: ${safeFilename}`);
  console.log(`[Image Request] Full path: ${filePath}`);
  console.log(`[Image Request] Exists: ${fs.existsSync(filePath)}`);

  // Check if file exists in uploads directory (primary location)
  if (fs.existsSync(filePath)) {
    console.log(`[Image Request] ✓ Serving: ${filePath}`);
    // Set headers before sending file
    res.setHeader("Content-Type", getContentType(safeFilename));
    res.setHeader("Cache-Control", "public, max-age=31536000");
    // Ensure CORS headers are set
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Credentials", "true");
    return res.sendFile(path.resolve(filePath));
  }

  // If not found, try to find it in the database (fallback for legacy paths)
  try {
    const pool = require("./database/connection");
    const [results] = await pool.query(
      "SELECT face_image, id_card_front, id_card_back FROM users WHERE face_image = ? OR face_image LIKE ? OR id_card_front = ? OR id_card_front LIKE ? OR id_card_back = ? OR id_card_back LIKE ?",
      [
        safeFilename,
        `%${safeFilename}%`,
        safeFilename,
        `%${safeFilename}%`,
        safeFilename,
        `%${safeFilename}%`,
      ]
    );

    console.log(
      `[Image Request] Found ${results.length} matching records in DB`
    );

    for (const user of results) {
      // Try face_image
      if (
        user.face_image &&
        (user.face_image === safeFilename ||
          user.face_image.includes(safeFilename))
      ) {
        // If stored as just filename, try uploads directory
        if (
          user.face_image === safeFilename ||
          path.basename(user.face_image) === safeFilename
        ) {
          const uploadPath = path.join(uploadsDir, safeFilename);
          if (fs.existsSync(uploadPath)) {
            console.log(
              `[Image Request] ✓ Serving from uploads (DB match): ${uploadPath}`
            );
            return res.sendFile(path.resolve(uploadPath), {
              headers: {
                "Content-Type": getContentType(safeFilename),
                "Cache-Control": "public, max-age=31536000",
              },
            });
          }
        }

        // If stored as absolute or relative path, try that
        let fullPath = user.face_image;
        if (!path.isAbsolute(fullPath)) {
          fullPath = path.join(uploadsDir, fullPath);
        }

        if (fs.existsSync(fullPath)) {
          console.log(`[Image Request] ✓ Serving from DB path: ${fullPath}`);
          return res.sendFile(path.resolve(fullPath), {
            headers: {
              "Content-Type": getContentType(safeFilename),
              "Cache-Control": "public, max-age=31536000",
            },
          });
        }
      }

      // Try id_card_front and id_card_back (same logic)
      for (const field of ["id_card_front", "id_card_back"]) {
        if (
          user[field] &&
          (user[field] === safeFilename || user[field].includes(safeFilename))
        ) {
          let fullPath = user[field];
          if (!path.isAbsolute(fullPath)) {
            fullPath = path.join(uploadsDir, fullPath);
          }
          if (fs.existsSync(fullPath)) {
            return res.sendFile(path.resolve(fullPath), {
              headers: {
                "Content-Type": getContentType(safeFilename),
                "Cache-Control": "public, max-age=31536000",
              },
            });
          }
        }
      }
    }

    console.log(`[Image Request] ✗ File not found: ${safeFilename}`);
    // Set CORS headers even for 404
    const origin = req.headers.origin;
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    } else {
      res.header("Access-Control-Allow-Origin", "*");
    }
    res.status(404).json({ error: "Image not found", filename: safeFilename });
  } catch (err) {
    console.error("[Image Request] Error:", err);
    // Set CORS headers even for errors
    const origin = req.headers.origin;
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    } else {
      res.header("Access-Control-Allow-Origin", "*");
    }
    res
      .status(500)
      .json({ error: "Error serving image", details: err.message });
  }
});

// Handle OPTIONS requests for CORS preflight
app.options("/uploads/:filename", (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

// Fallback static serving for uploads directory (after route handler)
app.use(
  "/uploads",
  (req, res, next) => {
    // Set CORS headers for static files
    const origin = req.headers.origin;
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    } else {
      res.header("Access-Control-Allow-Origin", "*");
    }
    res.header("Access-Control-Allow-Credentials", "true");
    next();
  },
  express.static(uploadsDir, {
    setHeaders: (res, filePath, stat) => {
      res.set("Cache-Control", "public, max-age=31536000");
      // CORS headers are already set in the middleware above
    },
  })
);

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/users/reports", require("./routes/reports"));
app.use("/api/orders", require("./routes/orders"));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "Server is running" });
});

// Error handling middleware - don't expose sensitive info
app.use((err, req, res, next) => {
  // Log full error for debugging (but don't send to client)
  console.error("Error:", {
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    path: req.path,
    method: req.method,
  });

  // Don't expose internal errors to client
  const status = err.status || 500;
  const message =
    status === 500
      ? "Internal server error"
      : err.message || "An error occurred";

  res.status(status).json({
    error: message,
  });
});

// Weekly reset scheduled task - runs every Thursday at 21:30 PM (9:30 PM)
// Note: Weekly sales are calculated dynamically, so this is mainly for logging/monitoring
cron.schedule(
  "30 21 * * 4",
  () => {
    const now = new Date();
    console.log(
      `[Weekly Reset] Weekly sales reset triggered at ${now.toISOString()}`
    );
    console.log(`[Weekly Reset] New week period started: Thursday 21:30 PM`);
    // Weekly sales are calculated dynamically from orders, so no database reset is needed
    // The calculation logic in routes/users.js handles the Thursday 21:30 PM week boundary
  },
  {
    timezone: "Asia/Colombo", // Sri Lanka Standard Time (SLST) - UTC+5:30
  }
);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(
    `[Scheduled Task] Weekly reset scheduled for every Thursday at 21:30 PM (9:30 PM)`
  );
});
