import 'dotenv/config';
import { app } from './app.js';
import { connectDatabase } from './config/database.js';
import { getMatchingWeights } from './services/matching.service.js';
import mongoose from 'mongoose';
const port=Number(process.env.PORT||4000);
if(!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32){console.error('JWT_SECRET must be set to at least 32 characters.');process.exit(1);}
try{getMatchingWeights();}catch(err){console.error(err.message);process.exit(1);}
try{
  await connectDatabase();
  const server=app.listen(port,()=>console.log(`EVIDEX API listening on port ${port}`));
  let shuttingDown=false;
  const shutdown=(signal)=>{
    if(shuttingDown)return;
    shuttingDown=true;
    console.log(`${signal} received; closing the API server.`);
    const forceTimer=setTimeout(()=>{
      console.error('Graceful shutdown timed out; closing remaining connections.');
      server.closeAllConnections();
    },10_000);
    forceTimer.unref();
    server.close(async(error)=>{
      clearTimeout(forceTimer);
      if(error)console.error(`HTTP server shutdown error: ${error.message}`);
      try{await mongoose.disconnect();console.log('MongoDB connection closed.');}
      catch(disconnectError){console.error(`MongoDB shutdown error: ${disconnectError.message}`);process.exitCode=1;}
    });
  };
  process.once('SIGINT',()=>shutdown('SIGINT'));
  process.once('SIGTERM',()=>shutdown('SIGTERM'));
}catch(err){console.error(`Database connection failed: ${err.message}`);await mongoose.disconnect().catch(()=>{});process.exit(1);}
