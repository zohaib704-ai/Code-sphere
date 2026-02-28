const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for development (enable in production)
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply rate limiting to API routes
app.use('/api/', limiter);

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

// Cache for language versions
let languageCache = {
    data: null,
    timestamp: null,
    ttl: 24 * 60 * 60 * 1000 // 24 hours
};

// Piston API configuration
const PISTON_API_URL = process.env.PISTON_API_URL || 'https://emkc.org/api/v2/piston';
const PISTON_API_KEY = process.env.PISTON_API_KEY; // Optional if API requires key

// Helper function to check if cache is valid
function isCacheValid() {
    return languageCache.data && 
           languageCache.timestamp && 
           (Date.now() - languageCache.timestamp) < languageCache.ttl;
}

// Helper function to format error messages
function formatError(error, context) {
    console.error(`Error in ${context}:`, error.message);
    
    if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        return {
            error: true,
            message: `Piston API error: ${error.response.status} - ${error.response.statusText}`,
            details: error.response.data
        };
    } else if (error.request) {
        // The request was made but no response was received
        return {
            error: true,
            message: 'No response received from Piston API. Please try again later.',
            details: error.request
        };
    } else {
        // Something happened in setting up the request that triggered an Error
        return {
            error: true,
            message: error.message
        };
    }
}

// Route to serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Get supported languages from Piston API
app.get('/api/languages', async (req, res) => {
    // Return cached data if valid
    if (isCacheValid()) {
        return res.json({
            success: true,
            cached: true,
            timestamp: languageCache.timestamp,
            languages: languageCache.data
        });
    }

    try {
        const response = await axios.get(`${PISTON_API_URL}/runtimes`, {
            timeout: 5000,
            headers: PISTON_API_KEY ? { 'Authorization': `Bearer ${PISTON_API_KEY}` } : {}
        });

        // Update cache
        languageCache.data = response.data;
        languageCache.timestamp = Date.now();

        res.json({
            success: true,
            cached: false,
            languages: response.data
        });
    } catch (error) {
        const errorResponse = formatError(error, 'fetching languages');
        res.status(500).json(errorResponse);
    }
});

// Execute code using Piston API
app.post('/api/execute', async (req, res) => {
    const { language, version, files, stdin, args = [], compile_timeout = 10000, run_timeout = 3000 } = req.body;

    // Validate required fields
    if (!language || !version || !files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({
            error: true,
            message: 'Missing required fields: language, version, and files are required'
        });
    }

    // Validate file structure
    for (const file of files) {
        if (!file.name || !file.content) {
            return res.status(400).json({
                error: true,
                message: 'Each file must have a name and content'
            });
        }
    }

    try {
        // Prepare the request to Piston API
        const pistonRequest = {
            language,
            version,
            files,
            stdin: stdin || '',
            args,
            compile_timeout,
            run_timeout
        };

        // Log execution (for debugging, remove in production)
        console.log(`Executing ${language} (${version}) code`);

        const response = await axios.post(`${PISTON_API_URL}/execute`, pistonRequest, {
            timeout: compile_timeout + run_timeout + 2000, // Add 2 seconds buffer
            headers: {
                'Content-Type': 'application/json',
                ...(PISTON_API_KEY && { 'Authorization': `Bearer ${PISTON_API_KEY}` })
            }
        });

        // Format the response
        const result = {
            success: true,
            executed: true,
            language,
            version,
            run: response.data.run,
            compile: response.data.compile
        };

        // Log execution result (for debugging)
        console.log(`Execution completed with code: ${response.data.run?.code || 'unknown'}`);

        res.json(result);
    } catch (error) {
        const errorResponse = formatError(error, 'code execution');
        
        // Enhance error message for specific cases
        if (error.code === 'ECONNABORTED') {
            errorResponse.message = 'Execution timeout. Your code took too long to run.';
        } else if (error.response?.status === 404) {
            errorResponse.message = 'Language or version not supported by Piston API';
        }

        res.status(error.response?.status || 500).json(errorResponse);
    }
});

// Batch execution endpoint (execute multiple code snippets)
app.post('/api/execute/batch', async (req, res) => {
    const { executions } = req.body;

    if (!executions || !Array.isArray(executions) || executions.length === 0) {
        return res.status(400).json({
            error: true,
            message: 'Missing required field: executions (array)'
        });
    }

    if (executions.length > 10) {
        return res.status(400).json({
            error: true,
            message: 'Maximum 10 executions per batch request'
        });
    }

    try {
        const results = await Promise.allSettled(
            executions.map(async (exec) => {
                const { language, version, files, stdin, args } = exec;
                
                const response = await axios.post(`${PISTON_API_URL}/execute`, {
                    language,
                    version,
                    files,
                    stdin: stdin || '',
                    args: args || [],
                    compile_timeout: 10000,
                    run_timeout: 3000
                }, {
                    timeout: 15000,
                    headers: PISTON_API_KEY ? { 'Authorization': `Bearer ${PISTON_API_KEY}` } : {}
                });

                return {
                    success: true,
                    language,
                    version,
                    result: response.data
                };
            })
        );

        res.json({
            success: true,
            results: results.map((result, index) => ({
                index,
                ...(result.status === 'fulfilled' 
                    ? result.value 
                    : { 
                        success: false, 
                        error: result.reason.message 
                    }
                )
            }))
        });
    } catch (error) {
        const errorResponse = formatError(error, 'batch execution');
        res.status(500).json(errorResponse);
    }
});

// Get specific language information
app.get('/api/language/:name', async (req, res) => {
    const { name } = req.params;

    try {
        // Get all runtimes first
        const response = await axios.get(`${PISTON_API_URL}/runtimes`, {
            timeout: 5000
        });

        // Find the language
        const languages = response.data;
        const language = languages.find(lang => 
            lang.language.toLowerCase() === name.toLowerCase() ||
            lang.aliases?.some(alias => alias.toLowerCase() === name.toLowerCase())
        );

        if (!language) {
            return res.status(404).json({
                error: true,
                message: `Language '${name}' not found`
            });
        }

        res.json({
            success: true,
            language
        });
    } catch (error) {
        const errorResponse = formatError(error, 'fetching language info');
        res.status(error.response?.status || 500).json(errorResponse);
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: true,
        message: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: true,
        message: 'Endpoint not found'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ CodeSphere server running on http://localhost:${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Piston API URL: ${PISTON_API_URL}`);
    
    // Pre-fetch languages on startup
    axios.get(`${PISTON_API_URL}/runtimes`, { timeout: 5000 })
        .then(response => {
            languageCache.data = response.data;
            languageCache.timestamp = Date.now();
            console.log(`✅ Cached ${response.data.length} languages from Piston API`);
        })
        .catch(error => {
            console.warn('⚠️ Could not pre-fetch languages from Piston API:', error.message);
        });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
