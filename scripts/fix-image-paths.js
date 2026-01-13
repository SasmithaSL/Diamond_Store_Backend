const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function fixImagePaths() {
  try {
    // Connect to database
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'topup_db'
    });

    console.log('Fixing image file paths...\n');

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
      console.log(`\nProcessing User ID ${user.id} (${user.name}):`);
      const updates = [];
      
      // Fix face_image
      if (user.face_image) {
        const faceImagePath = user.face_image;
        const isAbsolute = path.isAbsolute(faceImagePath) || faceImagePath.match(/^[A-Za-z]:/);
        
        let sourcePath = null;
        let targetFilename = path.basename(faceImagePath);
        
        if (isAbsolute) {
          // File is stored with absolute path
          sourcePath = faceImagePath;
          console.log(`  Face image is absolute path: ${faceImagePath}`);
        } else {
          // File is stored with relative path, check if it exists
          const relativePath = path.join(uploadsDir, faceImagePath);
          if (fs.existsSync(relativePath)) {
            console.log(`  ✓ Face image already in correct location: ${faceImagePath}`);
            // Still update DB to use just filename if it's a full relative path
            if (faceImagePath !== targetFilename) {
              updates.push({ field: 'face_image', value: targetFilename });
            }
            continue;
          }
          
          // Try to find it in common alternative locations
          const filename = path.basename(faceImagePath);
          const altPaths = [
            path.join('D:\\tests', filename),
            path.join('D:\\tests', faceImagePath),
            path.join(__dirname, '..', '..', 'tests', filename),
            path.join(__dirname, '..', '..', 'tests', faceImagePath)
          ];
          
          console.log(`  Looking for face image in alternative locations...`);
          for (const altPath of altPaths) {
            if (fs.existsSync(altPath)) {
              sourcePath = altPath;
              console.log(`  ✓ Found face image at: ${altPath}`);
              break;
            }
          }
        }
        
        if (sourcePath && fs.existsSync(sourcePath)) {
          const targetPath = path.join(uploadsDir, targetFilename);
          
          // Copy file to uploads directory
          try {
            fs.copyFileSync(sourcePath, targetPath);
            console.log(`  ✓ Copied face image to: ${targetPath}`);
            updates.push({ field: 'face_image', value: targetFilename });
          } catch (err) {
            console.error(`  ✗ Error copying face image: ${err.message}`);
          }
        } else {
          console.log(`  ✗ Face image not found: ${faceImagePath}`);
        }
      }

      // Fix id_card_front
      if (user.id_card_front) {
        const idFrontPath = user.id_card_front;
        const isAbsolute = path.isAbsolute(idFrontPath) || idFrontPath.match(/^[A-Za-z]:/);
        
        let sourcePath = isAbsolute ? idFrontPath : null;
        let targetFilename = path.basename(idFrontPath);
        
        if (!isAbsolute) {
          const relativePath = path.join(uploadsDir, idFrontPath);
          if (fs.existsSync(relativePath)) {
            continue;
          }
          // Try alternative locations
          const altPaths = [
            path.join('D:\\tests', idFrontPath),
            path.join('D:\\tests', targetFilename)
          ];
          for (const altPath of altPaths) {
            if (fs.existsSync(altPath)) {
              sourcePath = altPath;
              break;
            }
          }
        }
        
        if (sourcePath && fs.existsSync(sourcePath)) {
          const targetPath = path.join(uploadsDir, targetFilename);
          try {
            fs.copyFileSync(sourcePath, targetPath);
            console.log(`  ✓ Copied ID card front to: ${targetPath}`);
            updates.push({ field: 'id_card_front', value: targetFilename });
          } catch (err) {
            console.error(`  ✗ Error copying ID card front: ${err.message}`);
          }
        }
      }

      // Fix id_card_back
      if (user.id_card_back) {
        const idBackPath = user.id_card_back;
        const isAbsolute = path.isAbsolute(idBackPath) || idBackPath.match(/^[A-Za-z]:/);
        
        let sourcePath = isAbsolute ? idBackPath : null;
        let targetFilename = path.basename(idBackPath);
        
        if (!isAbsolute) {
          const relativePath = path.join(uploadsDir, idBackPath);
          if (fs.existsSync(relativePath)) {
            continue;
          }
          // Try alternative locations
          const altPaths = [
            path.join('D:\\tests', idBackPath),
            path.join('D:\\tests', targetFilename)
          ];
          for (const altPath of altPaths) {
            if (fs.existsSync(altPath)) {
              sourcePath = altPath;
              break;
            }
          }
        }
        
        if (sourcePath && fs.existsSync(sourcePath)) {
          const targetPath = path.join(uploadsDir, targetFilename);
          try {
            fs.copyFileSync(sourcePath, targetPath);
            console.log(`  ✓ Copied ID card back to: ${targetPath}`);
            updates.push({ field: 'id_card_back', value: targetFilename });
          } catch (err) {
            console.error(`  ✗ Error copying ID card back: ${err.message}`);
          }
        }
      }

      // Update database if we have updates
      if (updates.length > 0) {
        const updateFields = updates.map(u => `${u.field} = ?`).join(', ');
        const updateValues = updates.map(u => u.value);
        updateValues.push(user.id);
        
        await connection.query(
          `UPDATE users SET ${updateFields} WHERE id = ?`,
          updateValues
        );
        console.log(`  ✓ Updated database for user ${user.id}`);
      }
    }

    await connection.end();
    console.log('\n✓ Fix complete!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

fixImagePaths();

