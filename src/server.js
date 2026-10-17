import 'dotenv/config';
import { app } from './app.js';
import { connectDatabase } from './config/database.js';
const port=Number(process.env.PORT||4000);
if(!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32){console.error('JWT_SECRET must be set to at least 32 characters.');process.exit(1);}
try{await connectDatabase();app.listen(port,()=>console.log(`EVIDEX API listening on http://localhost:${port}`));}catch(err){console.error(`Database connection failed: ${err.message}`);process.exit(1);}
