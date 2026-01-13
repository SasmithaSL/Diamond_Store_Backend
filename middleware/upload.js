const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
// Use absolute path resolution to match server.js
const uploadDir = process.env.UPLOAD_PATH || './uploads';
const resolvedUploadDir = path.resolve(uploadDir);
if (!fs.existsSync(resolvedUploadDir)) {
  fs.mkdirSync(resolvedUploadDir, { recursive: true });
  console.log(`[Upload Middleware] Created uploads directory: ${resolvedUploadDir}`);
} else {
  console.log(`[Upload Middleware] Using uploads directory: ${resolvedUploadDir}`);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Use resolved path to ensure consistency
    const dest = path.resolve(uploadDir);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
      console.log(`[Upload] Created directory: ${dest}`);
    }
    console.log(`[Upload] Saving file to: ${dest}`);
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    let prefix = 'file-';
    
    // Set appropriate prefix based on field name
    if (file.fieldname === 'faceImage') {
      prefix = 'face-';
    } else if (file.fieldname === 'idCardFront') {
      prefix = 'id-front-';
    } else if (file.fieldname === 'idCardBack') {
      prefix = 'id-back-';
    } else if (file.fieldname === 'profilePhoto') {
      prefix = 'profile-';
    }
    
    // Preserve original file extension exactly as uploaded
    const originalExt = path.extname(file.originalname).toLowerCase();
    const filename = prefix + uniqueSuffix + originalExt;
    
    // Log for debugging
    console.log(`[Upload] Field: ${file.fieldname}, Original: ${file.originalname}, Extension: ${originalExt}, Filename: ${filename}`);
    console.log(`[Upload] Will be saved to: ${path.resolve(uploadDir, filename)}`);
    
    cb(null, filename);
  }
});

const fileFilter = (req, file, cb) => {
  // Whitelist approach - only allow specific MIME types
  const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
  const allowedExtensions = /\.(jpeg|jpg|png|gif)$/i;
  
  const extname = allowedExtensions.test(path.extname(file.originalname));
  const mimetype = allowedMimeTypes.includes(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (jpeg, jpg, png, gif)'));
  }
};

const upload = multer({
  storage: storage,
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB limit per file
    files: 3, // Allow up to 3 files (face, ID front, ID back)
    fieldSize: 10 * 1024 * 1024 // 10MB field size limit
  },
  fileFilter: fileFilter
});

// Export single file upload (for profile updates)
const uploadSingle = multer({
  storage: storage,
  limits: { 
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fieldSize: 10 * 1024 * 1024
  },
  fileFilter: fileFilter
});

// Export multiple file upload (for registration)
const uploadMultiple = multer({
  storage: storage,
  limits: { 
    fileSize: 5 * 1024 * 1024,
    files: 3,
    fieldSize: 10 * 1024 * 1024
  },
  fileFilter: fileFilter
}).fields([
  { name: 'faceImage', maxCount: 1 },
  { name: 'idCardFront', maxCount: 1 },
  { name: 'idCardBack', maxCount: 1 }
]);

// Export for order profile photo upload
const uploadOrderPhoto = multer({
  storage: storage,
  limits: { 
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fieldSize: 10 * 1024 * 1024
  },
  fileFilter: fileFilter
}).single('profilePhoto');

module.exports = uploadSingle;
module.exports.uploadMultiple = uploadMultiple;
module.exports.uploadOrderPhoto = uploadOrderPhoto;

