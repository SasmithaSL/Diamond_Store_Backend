const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function checkImageFiles() {
  try {
    // Connect to database
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'topup_db'
    });

    console.log('Checking image files in database...\n');

    // Get all users with image paths
    const [users] = await connection.query(
      'SELECT id, name, face_image, id_card_front, id_card_back FROM users WHERE face_image IS NOT NULL'
    );

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log(`Created uploads directory: ${uploadsDir}\n`);
    }

    for (const user of users) {
      console.log(`\nUser ID ${user.id} (${user.name}):`);
      
      // Check face_image
      if (user.face_image) {
        const faceImagePath = user.face_image;
        const isAbsolute = path.isAbsolute(faceImagePath) || faceImagePath.match(/^[A-Za-z]:/);
        
        console.log(`  Face Image: ${faceImagePath}`);
        console.log(`    Type: ${isAbsolute ? 'Absolute' : 'Relative'}`);
        
        let exists = false;
        let actualPath = null;
        
        if (isAbsolute) {
          exists = fs.existsSync(faceImagePath);
          actualPath = faceImagePath;
        } else {
          const relativePath = path.join(uploadsDir, faceImagePath);
          exists = fs.existsSync(relativePath);
          actualPath = relativePath;
        }
        
        console.log(`    Exists: ${exists ? '✓' : '✗'}`);
        if (exists) {
          console.log(`    Location: ${actualPath}`);
        } else {
          console.log(`    ✗ File not found at: ${actualPath}`);
          if (isAbsolute && fs.existsSync(faceImagePath)) {
            console.log(`    But exists at absolute path: ${faceImagePath}`);
          }
        }
      }

      // Check id_card_front
      if (user.id_card_front) {
        const idFrontPath = user.id_card_front;
        const isAbsolute = path.isAbsolute(idFrontPath) || idFrontPath.match(/^[A-Za-z]:/);
        const relativePath = path.join(uploadsDir, idFrontPath);
        const exists = isAbsolute ? fs.existsSync(idFrontPath) : fs.existsSync(relativePath);
        console.log(`  ID Card Front: ${exists ? '✓' : '✗'} ${idFrontPath}`);
      }

      // Check id_card_back
      if (user.id_card_back) {
        const idBackPath = user.id_card_back;
        const isAbsolute = path.isAbsolute(idBackPath) || idBackPath.match(/^[A-Za-z]:/);
        const relativePath = path.join(uploadsDir, idBackPath);
        const exists = isAbsolute ? fs.existsSync(idBackPath) : fs.existsSync(relativePath);
        console.log(`  ID Card Back: ${exists ? '✓' : '✗'} ${idBackPath}`);
      }
    }

    await connection.end();
    console.log('\n✓ Check complete!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkImageFiles();


