const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const port = 3001;

// Use an environment variable for the secret key.
// In development, you can create a .env file and use a library like `dotenv`.
// In production, the hosting provider will manage this.
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-and-long-random-string-for-jwt-for-dev-only';

// --- File Paths ---
// For production hosting, data that changes (like user data or logs) should be on a persistent disk.
// We'll use an environment variable to specify the data directory.
const DATA_DIRECTORY = process.env.DATA_DIR || __dirname;
const usersFilePath = path.join(DATA_DIRECTORY, 'users.csv');
const loginAttemptsFilePath = path.join(DATA_DIRECTORY, 'logindata.csv');
const detailsFilePath = path.join(__dirname, 'Infernos Details', 'User Details .csv');
const profilePicturesPath = path.join(DATA_DIRECTORY, 'Profile Picture');

// In-memory cache for users to avoid reading the file on every request
let users = [];

/**
 * A simple CSV parser. This is a lightweight replacement for using XLSX.readFile
 * for the user data, which can be more robust in a serverless environment.
 * @param {string} csvText The raw CSV text content.
 * @returns {Array<Object>} An array of objects.
 */
function simpleCsvParser(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 1) return [];
    const headerLine = lines.shift();
    // This regex handles simple CSVs, but not commas inside quotes.
    // For this project's data, it's sufficient.
    const headers = headerLine.split(',').map(h => h.trim());
    
    return lines.map(line => {
        if (!line.trim()) return null;
        const values = line.split(',');
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] ? values[i].trim() : undefined; });
        return obj;
    }).filter(Boolean); // Filter out any empty lines that became null
}
// ---
// SECURITY WARNING: Storing passwords in plain text is extremely insecure and
// should NEVER be done in a real application. This is for demonstration purposes only.
// In a real-world scenario, you must hash passwords using a strong algorithm like Argon2 or bcrypt.
// ---
/**
 * Creates the users.csv file with credentials from 106 to 210 if it doesn't exist.
 */
function initializeUserStore() {
    // On a serverless platform, the users.csv file MUST be part of the deployment.
    // We no longer attempt to create it at runtime, as the filesystem is read-only.
    // This function's only job now is to validate its existence.
    if (!fs.existsSync(usersFilePath)) {
        console.error('\x1b[31m%s\x1b[0m', `FATAL: The users file is missing at ${usersFilePath}.`);
        console.error('\x1b[33m%s\x1b[0m', 'This file is required for the application to run. Please ensure "users.csv" is committed to your Git repository.');
        // In a real app, you might throw an error here to halt initialization.
    }
}

/**
 * Loads users from the XLSX file into the in-memory cache.
 */
function loadUsers() {
    try {
        if (fs.existsSync(usersFilePath)) {
            // Switched from XLSX.readFile to a more direct read for robustness on Vercel
            const usersCsvData = fs.readFileSync(usersFilePath, 'utf8');
            users = simpleCsvParser(usersCsvData);
            console.log(`Successfully loaded ${users.length} users from ${path.basename(usersFilePath)}.`);

            // Check if the loaded data is in the old, insecure format.
            if (users.length > 0 && !users[0].hasOwnProperty('PasswordHash')) {
                console.error('\x1b[31m%s\x1b[0m', `FATAL: The ${path.basename(usersFilePath)} file appears to be in an old format with plaintext passwords.`);
                console.error('\x1b[33m%s\x1b[0m', `Please delete the "${path.basename(usersFilePath)}" file and restart the server to regenerate it with secure, hashed passwords.`);
                // In a real production app, you would want to stop the server from running in an insecure state.
                // process.exit(1);
            }

            // --- Sync with Infernos Details.xlsx ---
            if (fs.existsSync(detailsFilePath)) {
                console.log(`Found "${path.basename(detailsFilePath)}", attempting to sync data...`);
                // Switched from XLSX.readFile to a more direct read
                const detailsCsvData = fs.readFileSync(detailsFilePath, 'utf8');
                const detailsList = simpleCsvParser(detailsCsvData);

                const detailsMap = new Map();
                for (const detail of detailsList) {
                    // Use 'Roll Number' as the key for syncing.
                    if (detail['Roll Number']) {
                        detailsMap.set(String(detail['Roll Number']), detail);
                    }
                }

                let syncCount = 0;
                users.forEach(user => {
                    const loginId = String(user['Login ID']);
                    if (detailsMap.has(loginId)) {
                        const newDetails = detailsMap.get(loginId);
                        
                        // Override placeholder data with details from the new file, handling different column names.
                        Object.assign(user, {
                            'Name': newDetails['Name'] || user['Name'],
                            'Roll Number': newDetails['Roll Number'] || user['Roll Number'],
                            'Passing Year': newDetails['Passing Year'] || user['Passing Year'],
                            'Father’s Name': newDetails["Father's Name"] || newDetails['Father’s Name'] || user['Father’s Name'],
                            'Mother Name': newDetails["Mother's Name"] || newDetails['Mother Name'] || user['Mother Name'],
                            'Mob No': newDetails['Mob No'] || user['Mob No'],
                            'Email': newDetails['Email ID'] || newDetails['Email'] || user['Email']
                        });
                        syncCount++;
                    }
                });
                console.log(`Successfully synced details for ${syncCount} of ${users.length} users.`);
            } else {
                console.log(`"${path.basename(detailsFilePath)}" not found. Using default data from ${path.basename(usersFilePath)}.`);
            }
        } else {
            console.error(`Users file (${path.basename(usersFilePath)}) not found. Please create it or restart the server to initialize it.`);
        }
    } catch (error) {
        console.error('Failed to load or sync user data:', error);
        // In a real app, you might want to prevent the server from starting if users can't be loaded.
    }
}

/**
 * Saves the in-memory user store back to the users.xlsx file.
 */
function saveUsersToFile() {
    try {
        // NOTE: On a serverless platform like Vercel, the filesystem is read-only
        // or ephemeral. This means any changes written here will NOT be persisted
        // across requests or deployments. A database is required for this functionality
        // in a serverless environment.

        // Convert the in-memory user data (with hashes) back to a worksheet
        const worksheet = XLSX.utils.json_to_sheet(users);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Users');
        
        // Overwrite the existing file
        XLSX.writeFile(workbook, usersFilePath);
        console.log('Users file updated successfully.');
    } catch (error) {
        console.error('Failed to save users file:', error);
    }
}
// Middleware to parse JSON request bodies
app.use(express.json());

// --- Static File Serving ---
// SECURITY: Serving the entire directory with express.static(__dirname) is insecure.
// It exposes server-side files, including this one and your user data.
// Instead, we explicitly serve only the necessary HTML files.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/home.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/SSKAL.jpg', (req, res) => {
    res.sendFile(path.join(__dirname, 'SSKAL.jpg'));
});

app.get('/Sainik School Society.jpg', (req, res) => {
    res.sendFile(path.join(__dirname, 'Sainik School Society.jpg'));
});

app.get('/HeadcorpsStencil-K7WEW.otf', (req, res) => {
    res.sendFile(path.join(__dirname, 'HeadcorpsStencil-K7WEW.otf'));
});

app.get('/HeadcorpsStencil-MVWdp.ttf', (req, res) => {
    res.sendFile(path.join(__dirname, 'HeadcorpsStencil-MVWdp.ttf'));
});

app.get('/Chomsky.otf', (req, res) => {
    res.sendFile(path.join(__dirname, 'Chomsky.otf'));
});

/**
 * Middleware to authenticate a JWT token from the Authorization header.
 */
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (token == null) {
        return res.sendStatus(401); // Unauthorized: No token provided
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.sendStatus(403); // Forbidden: Token is invalid
        }
        req.user = user; // Add the decoded user payload to the request object
        next();
    });
}

// API endpoint to serve profile pictures
app.get('/profile-picture', authenticateToken, (req, res) => {
    const { loginId } = req.user;
    if (!loginId) {
        // This case should be handled by authenticateToken, but good to have
        return res.status(400).send('Login ID not found in token.');
    }

    const possibleExtensions = ['jpg', 'jpeg', 'png', 'gif'];
    let imagePath = null;
    const checkedPaths = [];

    for (const ext of possibleExtensions) {
        const tempPath = path.join(profilePicturesPath, `${loginId}.${ext}`);
        checkedPaths.push(tempPath);
        if (fs.existsSync(tempPath)) {
            imagePath = tempPath;
            break;
        }
    }

    if (imagePath) {
        console.log(`[PROFILE] Serving picture for user '${loginId}': ${imagePath}`);
        res.sendFile(imagePath);
    } else {
        // This enhanced logging will help you debug file path issues.
        console.log(`[PROFILE] No picture found for user '${loginId}'. Checked paths:`);
        checkedPaths.forEach(p => console.log(`  - ${p}`));
        // Send a 404 Not Found if no image exists for the user
        res.status(404).send('Profile picture not found.');
    }
});

// API endpoint to get details for the logged-in user
app.get('/user-details', authenticateToken, (req, res) => {
    const { loginId } = req.user;
    const userDetails = users.find(user => String(user['Login ID']) === String(loginId));

    if (userDetails) {
        // Ensure we don't send the password hash to the client
        const { PasswordHash, ...safeDetails } = userDetails;
        res.json(safeDetails);
    } else {
        res.status(404).json({ message: 'User not found.' });
    }
});

// API endpoint to handle the login data
app.post('/login', (req, res) => {
    try {
        const { loginId, password } = req.body;

        if (!loginId || !password) {
            return res.status(400).json({ message: 'Login ID and Password are required.' });
        }

        // --- Authentication Logic ---
        const foundUser = users.find(user => String(user['Login ID']) === String(loginId));
        let isAuthenticated = false;

        // This is the critical check. It ensures we have a user AND that user has a password hash.
        // This prevents crashes if the user record is malformed.
        if (foundUser) {
            // Check if the user record has a valid password hash.
            if (foundUser.PasswordHash && typeof foundUser.PasswordHash === 'string') {
                isAuthenticated = bcrypt.compareSync(String(password), foundUser.PasswordHash);
                if (!isAuthenticated) {
                    // This log is for the developer/admin, not the user.
                    console.log(`[AUTH] Login failed for user '${loginId}': Incorrect password provided.`);
                }
            } else {
                // This indicates a data integrity issue with this user's record.
                console.error(`[AUTH] Login failed for user '${loginId}': User record is missing a valid PasswordHash.`);
            }
        } else {
            // This is a standard failed login attempt.
            console.log(`[AUTH] Login failed: User '${loginId}' not found.`);
        }

        // --- Logging Logic ---
        // SECURITY: Do NOT log the plain-text password.
        const logData = [{
            'Timestamp': new Date().toISOString(),
            'Login ID': loginId,
            // 'Password': password, // Storing plain text password - REMOVED FOR SECURITY
            'Status': isAuthenticated ? 'Success' : 'Failure'
        }];

        try {
            // NOTE: On a serverless platform like Vercel, the filesystem is read-only
            // or ephemeral. This means log files written here will be lost.
            // For persistent logging, a dedicated logging service (like Vercel Logs)
            // or a database is required.

            // For CSV logging, appending is much more efficient than reading/writing the whole file.
            const csvLine = `${logData[0].Timestamp},"${logData[0]['Login ID']}",${logData[0].Status}\n`;
            
            if (fs.existsSync(loginAttemptsFilePath)) {
                fs.appendFileSync(loginAttemptsFilePath, csvLine, 'utf8');
            } else {
                // If the file doesn't exist, create it with a header row.
                const header = 'Timestamp,"Login ID",Status\n';
                fs.writeFileSync(loginAttemptsFilePath, header + csvLine, 'utf8');
            }
        } catch (error) {
            console.error('Error writing to login log file:', error);
            // Don't let logging failure prevent the response to the user
        }

        // --- Response Logic ---
        if (isAuthenticated) {
            // Create a JWT for the authenticated user
            const userPayload = { loginId: foundUser['Login ID'] };
            const accessToken = jwt.sign(userPayload, JWT_SECRET, { expiresIn: '1h' });
            res.status(200).json({ message: 'Login successful!', accessToken: accessToken, redirectUrl: '/home.html' });
        } else {
            res.status(401).json({ message: 'Invalid Login ID or Password.' });
        }
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ message: 'An unexpected server error occurred.' });
    }
});

app.post('/change-password', authenticateToken, (req, res) => {
    try {
        // The user's ID is now taken from the verified token, not the request body.
        // This is the core of the security fix.
        const { loginId } = req.user;
        const { oldPassword, newPassword, confirmPassword } = req.body;
        if (!loginId || !oldPassword || !newPassword || !confirmPassword) {
            return res.status(400).json({ message: 'All fields are required.' });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({ message: 'New passwords do not match.' });
        }

        // Password strength validation (source of truth is the server)
        const isStrong =
            newPassword.length >= 12 &&
            /[a-z]/.test(newPassword) &&
            /[A-Z]/.test(newPassword) &&
            /[0-9]/.test(newPassword) &&
            /[!@#$%^&*(),.?":{}|<>]/.test(newPassword);

        if (!isStrong) {
            return res.status(400).json({ message: 'Password does not meet the strength requirements.' });
        }

        const userIndex = users.findIndex(user => String(user['Login ID']) === String(loginId));

        if (userIndex === -1) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const user = users[userIndex];

        // Explicitly check for password hash to prevent bcrypt errors
        if (!user.PasswordHash) {
            console.error(`User ${loginId} has no password hash.`);
            return res.status(500).json({ message: 'Server error: User account is corrupted.' });
        }

        // Check if old password is correct
        const isOldPasswordCorrect = bcrypt.compareSync(String(oldPassword), user.PasswordHash);
        if (!isOldPasswordCorrect) {
            return res.status(401).json({ message: 'Incorrect old password.' });
        }

        // Hash the new password
        const saltRounds = 10;
        const newHashedPassword = bcrypt.hashSync(String(newPassword), saltRounds);

        // Update in-memory user data
        users[userIndex].PasswordHash = newHashedPassword;

        // Persist changes to the file
        saveUsersToFile();

        res.status(200).json({ message: 'Password changed successfully!' });
    } catch (error) {
        console.error('Error in /change-password:', error);
        res.status(500).json({ message: 'An unexpected server error occurred.' });
    }
});


// --- Server Initialization & Export for Vercel ---

// Create the user file if it doesn't exist. On Vercel, this will only run
// when the serverless function is built or on a cold start. Since the
// filesystem is read-only, this is mainly for initializing the app state.
initializeUserStore();

// Load users into memory for fast access. This will run on every cold start
// of the serverless function.
loadUsers();

// Export the Express app for Vercel's serverless environment
module.exports = app;