import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase } from './config/database.js';
import { Task } from './models/Work.js';
import { Opportunity } from './models/Venture.js';
try { await connectDatabase();
 await Task.updateOne({title:'Customer discovery mini study'},{$setOnInsert:{title:'Customer discovery mini study',goal:'Practice gathering behavioral evidence before building a solution.',description:'Interview three people who may experience a problem you care about. Ask about the last time it happened, current workarounds, and consequences. Do not pitch a solution during the first half.',category:'Research',difficulty:'Beginner',requiredSkills:['Research','Communication'],deliverables:[{name:'Interview notes',required:true},{name:'Pattern summary',required:true},{name:'Reflection',required:true}],rubric:[{criterion:'Behavior-focused questions',points:30,description:'Questions invite concrete recent examples.'},{criterion:'Evidence synthesis',points:40,description:'Summary separates observations from interpretation.'},{criterion:'Limitations',points:30,description:'Notes sample/context limitations.'}],allowedTools:'Any tools; disclose AI assistance.',version:1,status:'published'}},{upsert:true});
 for(const item of [{title:'Junior Product Researcher Trial',provider:'EVIDEX demo opportunity',description:'A sample opportunity for practicing user research.',requiredSkills:['Research','Communication'],eligibility:[],remote:true},{title:'Frontend Prototype Contributor',provider:'EVIDEX demo opportunity',description:'A sample opportunity for building accessible interfaces.',requiredSkills:['React','Accessibility'],eligibility:[],remote:true}]) await Opportunity.updateOne({title:item.title},{$setOnInsert:{...item,status:'published'}},{upsert:true});
 console.log('Demo tasks and opportunities seeded. No user outcomes or reviews are fabricated.');
} finally { await mongoose.disconnect(); }
