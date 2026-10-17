import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User } from './models/User.js';
import { Project, Evidence, Task, Attempt, Submission, VerificationRun, Review, Appeal } from './models/Work.js';
import { Idea, IdeaAnalysis, Experiment, ExperimentResult, Opportunity, MatchResult, Application } from './models/Venture.js';
import { ProfileShare } from './models/Sharing.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { deconstructIdea } from './services/gemini.service.js';
import { calculateMatch } from './services/matching.service.js';
import { buildDashboardSummary } from './services/dashboard.service.js';
import { canSubmitAttempt } from './services/submission.service.js';

export const app = express();
app.disable('x-powered-by'); app.use(helmet()); app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' })); app.use(express.json({ limit: '128kb' }));
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control','no-store'); next(); });
const limited = (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited });
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited });
const ok = (res, data, status=200) => res.status(status).json({ data });
const cleanUser = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, status: u.status, profile: u.profile });
const asyncRoute = (fn) => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const text = (max) => z.string().trim().max(max);
const registerSchema = z.object({ name: text(80).min(1), email: z.string().email().max(254), password: z.string().min(10).max(100), role: z.enum(['student','founder']).optional() });
app.get('/api/health', asyncRoute(async (_req,res) => { const database=(await import('mongoose')).default.connection.readyState===1?'connected':'disconnected';const status=database==='connected'?'ok':'degraded';return res.status(status==='ok'?200:503).json({data:{status,database}}); }));
app.post('/api/auth/register', authLimiter, asyncRoute(async (req,res) => { const input=registerSchema.parse(req.body); const email=input.email.toLowerCase(); if(await User.exists({email})) return res.status(409).json({error:{code:'EMAIL_EXISTS',message:'An account with this email already exists.'}}); const user=await User.create({name:input.name,email,passwordHash:await bcrypt.hash(input.password,12),role:input.role||'student',profile:{displayName:input.name}}); const token=jwt.sign({id:user.id,role:user.role,tokenVersion:user.tokenVersion},process.env.JWT_SECRET,{expiresIn:'7d'}); return ok(res,{user:cleanUser(user),token},201); }));
app.post('/api/auth/login', authLimiter, asyncRoute(async (req,res) => { const email=z.string().email().parse(req.body?.email).toLowerCase(); const password=z.string().min(1).max(100).parse(req.body?.password); const user=await User.findOne({email}); if(!user||user.status!=='active'||!(await bcrypt.compare(password,user.passwordHash))) return res.status(401).json({error:{code:'INVALID_CREDENTIALS',message:'Email or password is incorrect.'}}); return ok(res,{user:cleanUser(user),token:jwt.sign({id:user.id,role:user.role,tokenVersion:user.tokenVersion},process.env.JWT_SECRET,{expiresIn:'7d'})}); }));
app.get('/api/shared/profile',asyncRoute(async(req,res)=>{
  const token=req.get('x-profile-share');
  if(!token||!/^[-_A-Za-z0-9]{40,60}$/.test(token))return res.status(404).json({error:{code:'SHARE_NOT_FOUND',message:'This profile share is unavailable.'}});
  const tokenHash=createHash('sha256').update(token).digest('hex');
  const share=await ProfileShare.findOne({tokenHash,revokedAt:null,expiresAt:{$gt:new Date()}});
  if(!share)return res.status(404).json({error:{code:'SHARE_NOT_FOUND',message:'This profile share is unavailable.'}});
  const [owner,projects,evidence]=await Promise.all([
    User.findOne({_id:share.ownerId,status:'active'}).select('profile'),
    Project.find({_id:{$in:share.projectIds},userId:share.ownerId,archivedAt:null}).select('title description contribution repositoryUrl demoUrl skills'),
    Evidence.find({_id:{$in:share.evidenceIds},userId:share.ownerId,provenance:{$ne:'sample'},archivedAt:null}).select('type title sourceUrl skills provenance status createdAt'),
  ]);
  if(!owner)return res.status(404).json({error:{code:'SHARE_NOT_FOUND',message:'This profile share is unavailable.'}});
  const profile={};
  for(const field of share.profileFields)if(field==='skills')profile.skills=(owner.profile.skills||[]).map(skill=>({name:skill.name,proficiency:skill.proficiency,evidenceIds:(skill.evidenceIds||[]).filter(id=>share.evidenceIds.some(sharedId=>String(sharedId)===String(id)))}));else profile[field]=owner.profile[field];
  ok(res,{profile,projects,evidence,expiresAt:share.expiresAt});
}));
app.use('/api', requireAuth);
app.post('/api/profile/shares',asyncRoute(async(req,res)=>{
  const schema=z.object({profileFields:z.array(z.enum(['displayName','bio','interests','preferredRole','location','skills'])).max(6).default([]),projectIds:z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(20).default([]),evidenceIds:z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(20).default([]),expiresInDays:z.number().int().min(1).max(30).default(7)}).strict().refine(input=>input.profileFields.length+input.projectIds.length+input.evidenceIds.length>0);
  const input=schema.parse(req.body);
  if(new Set(input.profileFields).size!==input.profileFields.length||new Set(input.projectIds).size!==input.projectIds.length||new Set(input.evidenceIds).size!==input.evidenceIds.length)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'Share scopes cannot contain duplicates.'}});
  if(input.projectIds.length&&await Project.countDocuments({_id:{$in:input.projectIds},userId:req.user.id,archivedAt:null})!==input.projectIds.length)return res.status(404).json({error:{code:'NOT_FOUND',message:'One or more projects were not found.'}});
  if(input.evidenceIds.length&&await Evidence.countDocuments({_id:{$in:input.evidenceIds},userId:req.user.id,provenance:{$ne:'sample'},archivedAt:null})!==input.evidenceIds.length)return res.status(404).json({error:{code:'NOT_FOUND',message:'One or more evidence records were not found.'}});
  const shareToken=randomBytes(32).toString('base64url');
  const expiresAt=new Date(Date.now()+input.expiresInDays*24*60*60*1000);
  const share=await ProfileShare.create({ownerId:req.user.id,tokenHash:createHash('sha256').update(shareToken).digest('hex'),profileFields:input.profileFields,projectIds:input.projectIds,evidenceIds:input.evidenceIds,expiresAt});
  ok(res,{id:share.id,shareToken,expiresAt},201);
}));
app.get('/api/profile/shares/me',asyncRoute(async(req,res)=>ok(res,await ProfileShare.find({ownerId:req.user.id}).select('-tokenHash').sort({createdAt:-1}))));
app.delete('/api/profile/shares/:id',asyncRoute(async(req,res)=>{
  const share=await ProfileShare.findOne({_id:req.params.id,ownerId:req.user.id,revokedAt:null});
  if(!share)return res.status(404).json({error:{code:'NOT_FOUND',message:'Active profile share not found.'}});
  share.revokedAt=new Date();
  await share.save();
  ok(res,{id:share.id,revokedAt:share.revokedAt});
}));
app.get('/api/dashboard',asyncRoute(async(req,res)=>{
  const userId=req.user.id;
  const [evidenceCount,completedTaskCount,pendingReviewCount,changesRequestedCount,activeAttempt,plannedExperiment,latestMatch,ideas,submissions,projects,results,recentEvidence]=await Promise.all([
    Evidence.countDocuments({userId,provenance:{$ne:'sample'},archivedAt:null}),
    Attempt.countDocuments({userId,isSample:{$ne:true},status:'verified'}),
    Submission.countDocuments({userId,isSample:{$ne:true},status:{$in:['submitted','checks_passed','needs_review']}}),
    Submission.countDocuments({userId,isSample:{$ne:true},status:'changes_requested'}),
    Attempt.findOne({userId,isSample:{$ne:true},status:'in_progress'}).sort({startedAt:1}).populate({path:'taskId',select:'title'}),
    Experiment.findOne({userId,status:'planned'}).sort({createdAt:1}).select('_id hypothesis'),
    MatchResult.findOne({userId}).sort({calculatedAt:-1}).populate({path:'opportunityId',select:'title provider roleType'}),
    Idea.find({userId}).sort({updatedAt:-1}).limit(3).select('title status updatedAt'),
    Submission.find({userId,isSample:{$ne:true}}).sort({submittedAt:-1}).limit(8).select('_id status submittedAt'),
    Project.find({userId,archivedAt:null}).sort({updatedAt:-1}).limit(5).select('_id title updatedAt'),
    ExperimentResult.find({userId}).sort({createdAt:-1}).limit(5).select('_id observations createdAt'),
    Evidence.find({userId,provenance:{$ne:'sample'},archivedAt:null}).sort({createdAt:-1}).limit(5).select('_id title status createdAt'),
  ]);
  const submissionIds=submissions.map((item)=>item._id);
  const reviews=submissionIds.length?await Review.find({submissionId:{$in:submissionIds}}).sort({createdAt:-1}).limit(8).select('submissionId decision createdAt'):[];
  const submissionActivity=submissions.map((item)=>({type:'submission',id:item.id,title:'Task submission',status:item.status,date:item.submittedAt}));
  const reviewActivity=reviews.map((item)=>({type:'review',id:item.id,relatedSubmissionId:item.submissionId,title:'Submission review',status:item.decision,date:item.createdAt}));
  const projectActivity=projects.map((item)=>({type:'project',id:item.id,title:item.title,status:'updated',date:item.updatedAt}));
  const resultActivity=results.map((item)=>({type:'experiment_result',id:item.id,title:'Experiment result recorded',status:'recorded',date:item.createdAt}));
  const evidenceActivity=recentEvidence.map((item)=>({type:'evidence',id:item.id,title:item.title,status:item.status,date:item.createdAt}));
  const active=activeAttempt?{id:activeAttempt.id,taskTitle:activeAttempt.taskId?.title||'your active task'}:null;
  const nextExperiment=plannedExperiment?{id:plannedExperiment.id}:null;
  const opportunityMatchPreview=latestMatch?{score:latestMatch.score,eligibility:latestMatch.eligibility,explanation:latestMatch.explanation,calculatedAt:latestMatch.calculatedAt,opportunity:latestMatch.opportunityId}:null;
  return ok(res,buildDashboardSummary({evidenceCount,completedTaskCount,pendingReviewCount,changesRequestedCount,activeAttempt:active,plannedExperiment:nextExperiment,latestMatch:opportunityMatchPreview,ideas,recentActivity:[...submissionActivity,...reviewActivity,...projectActivity,...resultActivity,...evidenceActivity]}));
}));
app.get('/api/profile/me',asyncRoute(async(req,res)=>{const u=await User.findById(req.user.id); if(!u)return res.status(404).json({error:{code:'NOT_FOUND',message:'User not found.'}}); ok(res,cleanUser(u));}));
app.patch('/api/profile/me',asyncRoute(async(req,res)=>{const schema=z.object({bio:text(800).optional(),interests:z.array(text(60)).max(20).optional(),preferredRole:text(100).optional(),location:text(100).optional(),visibility:z.enum(['private','public']).optional(),skills:z.array(z.object({name:text(60).min(1),proficiency:z.enum(['beginner','intermediate','advanced']).default('beginner'),evidenceIds:z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(100).optional()})).max(40).optional()}).strict(); const fields=schema.parse(req.body);const linkedIds=[...new Set((fields.skills||[]).flatMap(skill=>skill.evidenceIds||[]))];if(linkedIds.length&&await Evidence.countDocuments({_id:{$in:linkedIds},userId:req.user.id,archivedAt:null})!==linkedIds.length)return res.status(404).json({error:{code:'NOT_FOUND',message:'One or more evidence records were not found.'}}); const u=await User.findByIdAndUpdate(req.user.id,{$set:Object.fromEntries(Object.entries(fields).map(([k,v])=>[`profile.${k}`,v]))},{new:true,runValidators:true}); ok(res,cleanUser(u));}));
app.patch('/api/admin/users/:id/access',requireRole('admin'),asyncRoute(async(req,res)=>{
  const input=z.object({role:z.enum(['student','founder','reviewer','mentor','admin']).optional(),status:z.enum(['active','suspended']).optional()}).strict().refine(value=>Object.keys(value).length>0);
  const fields=input.parse(req.body);
  if(req.params.id===req.user.id)return res.status(403).json({error:{code:'FORBIDDEN',message:'Admins cannot change their own account access.'}});
  const target=await User.findById(req.params.id);
  if(!target)return res.status(404).json({error:{code:'NOT_FOUND',message:'User not found.'}});
  const role=fields.role||target.role;
  const status=fields.status||target.status;
  if(role===target.role&&status===target.status)return ok(res,cleanUser(target));
  if(target.role==='admin'&&target.status==='active'&&(role!=='admin'||status!=='active')&&await User.countDocuments({role:'admin',status:'active'})<=1)return res.status(409).json({error:{code:'LAST_ACTIVE_ADMIN',message:'At least one active admin account must remain.'}});
  target.accessHistory.push({changedBy:req.user.id,source:'admin_api',previousRole:target.role,role,previousStatus:target.status,status});
  if(target.accessHistory.length>50)target.accessHistory=target.accessHistory.slice(-50);
  target.role=role;
  target.status=status;
  target.tokenVersion+=1;
  await target.save();
  ok(res,cleanUser(target));
}));
app.get('/api/admin/users/:id/access-history',requireRole('admin'),asyncRoute(async(req,res)=>{
  const target=await User.findById(req.params.id).select('accessHistory');
  if(!target)return res.status(404).json({error:{code:'NOT_FOUND',message:'User not found.'}});
  ok(res,target.accessHistory);
}));
const projectSchema=z.object({title:text(120).min(1),description:text(1500).optional(),contribution:text(800).optional(),repositoryUrl:z.string().url().optional().or(z.literal('')),demoUrl:z.string().url().optional().or(z.literal('')),skills:z.array(text(60)).max(30).optional()}).strict();
const evidenceSchema=z.object({title:text(160).min(1),type:z.enum(['project','task_submission','certificate','experiment','other']).optional(),sourceUrl:z.string().url().optional().or(z.literal('')),skills:z.array(text(60)).max(30).optional(),relatedProjectId:z.string().regex(/^[a-f\d]{24}$/i).optional()}).strict();
app.get('/api/projects/me',asyncRoute(async(req,res)=>ok(res,await Project.find({userId:req.user.id,archivedAt:null}).sort({updatedAt:-1}))));
app.post('/api/projects',asyncRoute(async(req,res)=>{const p=await Project.create({...projectSchema.parse(req.body),userId:req.user.id});ok(res,p,201);}));
app.patch('/api/projects/:id',asyncRoute(async(req,res)=>{
  const fields=projectSchema.partial().refine(value=>Object.keys(value).length>0).parse(req.body);
  const project=await Project.findOne({_id:req.params.id,userId:req.user.id,archivedAt:null});
  if(!project)return res.status(404).json({error:{code:'NOT_FOUND',message:'Project not found.'}});
  Object.assign(project,fields);
  await project.save();
  ok(res,project);
}));
app.delete('/api/projects/:id',asyncRoute(async(req,res)=>{
  const project=await Project.findOne({_id:req.params.id,userId:req.user.id,archivedAt:null});
  if(!project)return res.status(404).json({error:{code:'NOT_FOUND',message:'Project not found.'}});
  project.archivedAt=new Date();
  await project.save();
  ok(res,{id:project.id,archivedAt:project.archivedAt});
}));
app.post('/api/evidence',asyncRoute(async(req,res)=>{
  const input=evidenceSchema.parse(req.body);
  if(input.relatedProjectId&&!await Project.exists({_id:input.relatedProjectId,userId:req.user.id,archivedAt:null}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Project not found.'}});
  const e=await Evidence.create({...input,userId:req.user.id});
  ok(res,e,201);
}));
app.get('/api/evidence/me',asyncRoute(async(req,res)=>ok(res,await Evidence.find({userId:req.user.id,archivedAt:null}).sort({createdAt:-1}))));
app.patch('/api/evidence/:id',asyncRoute(async(req,res)=>{
  const schema=z.object({title:text(160).min(1).optional(),type:z.enum(['project','task_submission','certificate','experiment','other']).optional(),sourceUrl:z.string().url().optional().or(z.literal('')),skills:z.array(text(60)).max(30).optional(),relatedProjectId:z.string().regex(/^[a-f\d]{24}$/i).nullable().optional()}).strict().refine(value=>Object.keys(value).length>0);
  const fields=schema.parse(req.body);
  const evidence=await Evidence.findOne({_id:req.params.id,userId:req.user.id,archivedAt:null});
  if(!evidence)return res.status(404).json({error:{code:'NOT_FOUND',message:'Evidence not found.'}});
  if(evidence.provenance==='sample'||evidence.relatedSubmissionId)return res.status(409).json({error:{code:'SYSTEM_MANAGED_RECORD',message:'Task-submission and sample evidence cannot be edited.'}});
  if(fields.relatedProjectId&&!await Project.exists({_id:fields.relatedProjectId,userId:req.user.id,archivedAt:null}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Project not found.'}});
  Object.assign(evidence,fields,{status:'submitted',provenance:'user_reported'});
  await evidence.save();
  ok(res,evidence);
}));
app.delete('/api/evidence/:id',asyncRoute(async(req,res)=>{
  const evidence=await Evidence.findOne({_id:req.params.id,userId:req.user.id,archivedAt:null});
  if(!evidence)return res.status(404).json({error:{code:'NOT_FOUND',message:'Evidence not found.'}});
  if(evidence.provenance==='sample'||evidence.relatedSubmissionId)return res.status(409).json({error:{code:'SYSTEM_MANAGED_RECORD',message:'Task-submission and sample evidence cannot be archived.'}});
  evidence.archivedAt=new Date();
  await evidence.save();
  const owner=await User.findById(req.user.id);
  if(owner){
    owner.profile.skills=owner.profile.skills.map(skill=>{skill.evidenceIds=(skill.evidenceIds||[]).filter(id=>String(id)!==String(evidence.id));return skill;});
    await owner.save();
  }
  ok(res,{id:evidence.id,archivedAt:evidence.archivedAt});
}));
const taskSchema=z.object({title:text(120).min(1),goal:text(500).min(1),description:text(5000).min(1),category:text(80).min(1).optional(),difficulty:z.enum(['Beginner','Intermediate','Advanced']).optional(),requiredSkills:z.array(text(60).min(1)).max(30).default([]),deliverables:z.array(z.object({name:text(120).min(1),required:z.boolean().default(true)}).strict()).min(1).max(30),rubric:z.array(z.object({criterion:text(120).min(1),points:z.number().positive(),description:text(1000).min(1)}).strict()).min(1).max(30),allowedTools:text(500).optional(),status:z.enum(['draft','published']).optional()}).strict();
app.get('/api/admin/tasks',requireRole('admin'),asyncRoute(async(_req,res)=>ok(res,await Task.find({}).sort({updatedAt:-1}))));
app.post('/api/admin/tasks',requireRole('admin'),asyncRoute(async(req,res)=>{const fields=taskSchema.parse(req.body);const task=await Task.create({...fields,category:fields.category||'General',allowedTools:fields.allowedTools||'Any tools; disclose AI assistance.',version:1,status:fields.status||'draft'});ok(res,task,201);}));
app.patch('/api/admin/tasks/:id',requireRole('admin'),asyncRoute(async(req,res)=>{
  const fields=taskSchema.partial().extend({status:z.enum(['draft','published']).optional()}).strict().refine(value=>Object.keys(value).length>0).parse(req.body);
  const task=await Task.findOne({_id:req.params.id,status:{$ne:'archived'}});
  if(!task)return res.status(404).json({error:{code:'NOT_FOUND',message:'Task not found.'}});
  Object.assign(task,fields);
  task.version+=1;
  await task.save();
  ok(res,task);
}));
app.delete('/api/admin/tasks/:id',requireRole('admin'),asyncRoute(async(req,res)=>{
  const task=await Task.findOne({_id:req.params.id,status:{$ne:'archived'}});
  if(!task)return res.status(404).json({error:{code:'NOT_FOUND',message:'Task not found.'}});
  task.status='archived';
  task.version+=1;
  await task.save();
  ok(res,{id:task.id,status:task.status,version:task.version});
}));
app.get('/api/tasks',asyncRoute(async(_req,res)=>ok(res,await Task.find({status:'published'}).sort({createdAt:-1}))));
app.get('/api/tasks/:id',asyncRoute(async(req,res)=>{const task=await Task.findOne({_id:req.params.id,status:'published'});return task?ok(res,task):res.status(404).json({error:{code:'NOT_FOUND',message:'Task not found.'}});}));
app.post('/api/tasks/:id/attempts',asyncRoute(async(req,res)=>{
  const task=await Task.findOne({_id:req.params.id,status:'published'});
  if(!task)return res.status(404).json({error:{code:'NOT_FOUND',message:'Task not found.'}});
  const taskSnapshot={title:task.title,goal:task.goal,description:task.description,category:task.category,difficulty:task.difficulty,requiredSkills:task.requiredSkills,deliverables:task.deliverables.map(({name,required})=>({name,required})),rubric:task.rubric.map(({criterion,points,description})=>({criterion,points,description})),allowedTools:task.allowedTools};
  ok(res,await Attempt.create({taskId:task.id,userId:req.user.id,taskVersion:task.version,taskSnapshot}),201);
}));
app.get('/api/submissions/me',asyncRoute(async(req,res)=>ok(res,await Submission.find({userId:req.user.id}).sort({submittedAt:-1}).populate({path:'attemptId',populate:{path:'taskId',select:'title category difficulty'}}))));
app.post('/api/attempts/:id/submissions',asyncRoute(async(req,res)=>{const attempt=await Attempt.findOne({_id:req.params.id,userId:req.user.id});if(!attempt)return res.status(404).json({error:{code:'NOT_FOUND',message:'Attempt not found.'}});if(!canSubmitAttempt(attempt.status))return res.status(409).json({error:{code:'INVALID_STATUS',message:'This attempt can only be submitted once, or resubmitted after changes are requested.'}});const s=z.object({deliverables:z.array(z.object({name:text(120).min(1),value:text(3000).min(1)})).min(1).max(20),notes:text(3000).optional(),aiAssistance:text(500).optional()}).parse(req.body);const currentTask=await Task.findById(attempt.taskId);const task=attempt.taskSnapshot||currentTask;const missing=(task?.deliverables||[]).filter(d=>d.required&&!s.deliverables.some(x=>x.name.toLowerCase()===d.name.toLowerCase()));if(missing.length)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:`Required deliverables missing: ${missing.map(x=>x.name).join(', ')}`}});const version=(await Submission.countDocuments({attemptId:attempt.id}))+1;const sub=await Submission.create({...s,attemptId:attempt.id,userId:req.user.id,version});const taskTitle=task?.title||'Trial task';await Evidence.create({userId:req.user.id,type:'task_submission',title:`${taskTitle} submission v${version}`,relatedSubmissionId:sub.id,skills:task?.requiredSkills||[],provenance:'user_reported',status:'submitted'});attempt.status='submitted';attempt.submittedAt=new Date();await attempt.save();ok(res,sub,201);}));
app.get('/api/attempts/:id/submissions',asyncRoute(async(req,res)=>{const attempt=await Attempt.findOne({_id:req.params.id,userId:req.user.id});if(!attempt)return res.status(404).json({error:{code:'NOT_FOUND',message:'Attempt not found.'}});ok(res,await Submission.find({attemptId:attempt.id,userId:req.user.id}).sort({version:1}));}));
app.get('/api/submissions/:id/verification',asyncRoute(async(req,res)=>{const sub=await Submission.findById(req.params.id);if(!sub)return res.status(404).json({error:{code:'NOT_FOUND',message:'Submission not found.'}});if(String(sub.userId)!==req.user.id&&!['reviewer','admin'].includes(req.user.role))return res.status(404).json({error:{code:'NOT_FOUND',message:'Submission not found.'}});ok(res,{submission:sub,runs:await VerificationRun.find({submissionId:sub.id}).sort({createdAt:-1}),reviews:await Review.find({submissionId:sub.id}).sort({createdAt:1}),warnings:['Automated checks do not establish authorship.']});}));
app.post('/api/submissions/:id/verify',asyncRoute(async(req,res)=>{
  const sub=await Submission.findOne({_id:req.params.id,userId:req.user.id});
  if(!sub)return res.status(404).json({error:{code:'NOT_FOUND',message:'Submission not found.'}});
  if(sub.isSample)return res.status(409).json({error:{code:'SAMPLE_RECORD',message:'Sample submissions cannot be verified.'}});
  const attempt=await Attempt.findOne({_id:sub.attemptId,userId:req.user.id});
  const currentTask=attempt?await Task.findById(attempt.taskId):null;
  const task=attempt?.taskSnapshot||currentTask;
  if(!task)return res.status(404).json({error:{code:'NOT_FOUND',message:'Task definition not found.'}});
  const submitted=new Map((sub.deliverables||[]).map(item=>[item.name.trim().toLowerCase(),item.value.trim()]));
  const required=(task.deliverables||[]).filter(item=>item.required);
  const checks=required.length?required.map(item=>{
    const value=submitted.get(item.name.trim().toLowerCase());
    const passed=Boolean(value);
    return {name:`Completeness: ${item.name}`,status:passed?'passed':'failed',meaning:passed?'The required deliverable contains a non-empty value.':'The required deliverable is missing or empty.'};
  }):[{name:'Submission content',status:sub.deliverables.length&&[...submitted.values()].every(Boolean)?'passed':'failed',meaning:'At least one non-empty deliverable was submitted.'}];
  const passed=checks.every(check=>check.status==='passed');
  sub.status=passed?'checks_passed':'needs_review';
  await sub.save();
  await Evidence.updateMany({relatedSubmissionId:sub.id},{$set:{status:sub.status,provenance:'automated_check'}});
  await Attempt.findByIdAndUpdate(sub.attemptId,{status:sub.status});
  const warnings=['Only deliverable completeness is checked. Task-specific correctness, source accessibility, Git work history, similarity, and authorship are not checked.'];
  const run=await VerificationRun.create({submissionId:sub.id,checks,results:{overallStatus:sub.status},warnings});
  ok(res,{submission:sub,verification:run,checks,warnings});
}));
app.get('/api/reviews/queue',requireRole('reviewer','admin'),asyncRoute(async(_req,res)=>ok(res,await Submission.find({isSample:{$ne:true},status:{$in:['submitted','checks_passed','needs_review']}}).sort({submittedAt:1}).limit(100).populate({path:'attemptId',populate:{path:'taskId',select:'title category difficulty rubric'}}))));
app.get('/api/submissions/:id/reviews',asyncRoute(async(req,res)=>{const sub=await Submission.findById(req.params.id);if(!sub)return res.status(404).json({error:{code:'NOT_FOUND',message:'Submission not found.'}});if(String(sub.userId)!==req.user.id&&!['reviewer','admin'].includes(req.user.role))return res.status(404).json({error:{code:'NOT_FOUND',message:'Submission not found.'}});ok(res,await Review.find({submissionId:sub.id}).sort({createdAt:1}));}));
app.post('/api/submissions/:id/reviews',requireRole('reviewer','admin'),asyncRoute(async(req,res)=>{const sub=await Submission.findById(req.params.id);if(!sub)return res.status(404).json({error:{code:'NOT_FOUND',message:'Submission not found.'}});if(sub.isSample)return res.status(409).json({error:{code:'SAMPLE_RECORD',message:'Sample submissions cannot be reviewed.'}});if(String(sub.userId)===req.user.id)return res.status(403).json({error:{code:'FORBIDDEN',message:'You cannot review your own submission.'}});if(!['submitted','checks_passed','needs_review'].includes(sub.status))return res.status(409).json({error:{code:'INVALID_STATUS',message:'This submission is not awaiting review.'}});const attempt=await Attempt.findOne({_id:sub.attemptId,userId:sub.userId});const currentTask=attempt?await Task.findById(attempt.taskId):null;const task=attempt?.taskSnapshot||currentTask;if(!task)return res.status(404).json({error:{code:'NOT_FOUND',message:'Task rubric not found.'}});const scoreSchema=z.object({criterion:text(120),score:z.number().min(0),maxScore:z.number().positive()}).refine(s=>s.score<=s.maxScore,{message:'Score cannot exceed the maximum.'});const input=z.object({rubricScores:z.array(scoreSchema).min(1).max(30),feedback:text(3000).min(1),decision:z.enum(['verified','changes_requested','rejected'])}).parse(req.body);const rubric=task.rubric||[];const invalid=input.rubricScores.length!==rubric.length||new Set(input.rubricScores.map(score=>score.criterion)).size!==rubric.length||input.rubricScores.some(score=>{const criterion=rubric.find(item=>item.criterion===score.criterion);return !criterion||Number(criterion.points)!==score.maxScore;});if(invalid)return res.status(400).json({error:{code:'INVALID_RUBRIC',message:'Provide one score for every task rubric criterion using its configured maximum.'}});const review=await Review.create({...input,submissionId:sub.id,reviewerId:req.user.id});sub.status=input.decision;await sub.save();await Evidence.updateMany({relatedSubmissionId:sub.id},{$set:{status:input.decision,provenance:'reviewed'}});await Attempt.findByIdAndUpdate(sub.attemptId,{status:input.decision});ok(res,review,201);}));
app.get('/api/appeals/me',asyncRoute(async(req,res)=>ok(res,await Appeal.find({userId:req.user.id}).sort({createdAt:-1}).populate('submissionId','status submittedAt'))));
app.post('/api/submissions/:id/appeals',asyncRoute(async(req,res)=>{
  const sub=await Submission.findOne({_id:req.params.id,userId:req.user.id});
  if(!sub)return res.status(404).json({error:{code:'NOT_FOUND',message:'Submission not found.'}});
  if(sub.isSample)return res.status(409).json({error:{code:'SAMPLE_RECORD',message:'Sample submissions cannot be appealed.'}});
  if(sub.status!=='rejected')return res.status(409).json({error:{code:'INVALID_STATUS',message:'Only rejected submissions can be appealed.'}});
  const input=z.object({reason:text(2000).min(1)}).strict().parse(req.body);
  ok(res,await Appeal.create({submissionId:sub.id,userId:req.user.id,reason:input.reason}),201);
}));
app.get('/api/appeals/queue',requireRole('reviewer','admin'),asyncRoute(async(_req,res)=>ok(res,await Appeal.find({status:'submitted'}).sort({createdAt:1}).limit(100).populate('submissionId','status submittedAt userId'))));
app.post('/api/appeals/:id/resolve',requireRole('reviewer','admin'),asyncRoute(async(req,res)=>{
  const appeal=await Appeal.findOne({_id:req.params.id,status:'submitted'});
  if(!appeal)return res.status(404).json({error:{code:'NOT_FOUND',message:'Pending appeal not found.'}});
  if(String(appeal.userId)===req.user.id)return res.status(403).json({error:{code:'FORBIDDEN',message:'You cannot resolve your own appeal.'}});
  if(await Review.exists({submissionId:appeal.submissionId,reviewerId:req.user.id}))return res.status(403).json({error:{code:'FORBIDDEN',message:'The original reviewer cannot resolve this appeal.'}});
  const input=z.object({decision:z.enum(['upheld','overturned']),resolution:text(3000).min(1)}).strict().parse(req.body);
  const sub=await Submission.findById(appeal.submissionId);
  if(!sub)return res.status(404).json({error:{code:'NOT_FOUND',message:'Submission not found.'}});
  appeal.status=input.decision;
  appeal.resolution=input.resolution;
  appeal.resolverId=req.user.id;
  appeal.resolvedAt=new Date();
  await appeal.save();
  if(input.decision==='overturned'){
    sub.status='changes_requested';
    await sub.save();
    await Attempt.findByIdAndUpdate(sub.attemptId,{status:'changes_requested'});
    await Evidence.updateMany({relatedSubmissionId:sub.id},{$set:{status:'changes_requested'}});
  }
  ok(res,{appeal,submission:sub});
}));
app.get('/api/ideas',asyncRoute(async(req,res)=>ok(res,await Idea.find({userId:req.user.id}).sort({updatedAt:-1}))));
app.post('/api/ideas',asyncRoute(async(req,res)=>{const idea=await Idea.create({...z.object({title:text(120).min(1),description:text(5000).min(1),targetCustomer:text(500).optional(),problem:text(1000).optional(),proposedSolution:text(1000).optional(),alternatives:text(1000).optional()}).parse(req.body),userId:req.user.id});ok(res,idea,201);}));
app.post('/api/venture/deconstruct',aiLimiter,asyncRoute(async(req,res)=>{const idea=await Idea.findOne({_id:z.string().regex(/^[a-f\d]{24}$/i).parse(req.body?.ideaId),userId:req.user.id});if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});let generated;try{generated=await deconstructIdea(idea);}catch(err){console.error('Gemini request failed',err?.message);return res.status(503).json({error:{code:'AI_UNAVAILABLE',message:'Idea analysis is temporarily unavailable. Your saved idea is safe; please retry or continue manually.'}});}const saved=await IdeaAnalysis.create({ideaId:idea.id,userId:req.user.id,model:generated.model,source:generated.source,...generated.data});const experiments=await Experiment.insertMany(generated.data.experiments.map(e=>({...e,ideaId:idea.id,userId:req.user.id,status:'planned'})));idea.status='test_planned';await idea.save();ok(res,{analysis:saved,experiments,notice:generated.source==='sample'?'Sample response — not generated live. Configure GEMINI_API_KEY for live analysis.':'AI-generated suggestions, not verified facts or market research.'},201);}));
app.get('/api/ideas/:id/analyses',asyncRoute(async(req,res)=>{const idea=await Idea.exists({_id:req.params.id,userId:req.user.id});if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});ok(res,await IdeaAnalysis.find({ideaId:req.params.id,userId:req.user.id}).sort({createdAt:-1}));}));
app.get('/api/ideas/:id/results',asyncRoute(async(req,res)=>{const idea=await Idea.exists({_id:req.params.id,userId:req.user.id});if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});const experiments=await Experiment.find({ideaId:req.params.id,userId:req.user.id}).select('_id');ok(res,await ExperimentResult.find({experimentId:{$in:experiments.map(e=>e._id)},userId:req.user.id}).sort({createdAt:-1}));}));
app.get('/api/ideas/:id/experiments',asyncRoute(async(req,res)=>{const idea=await Idea.exists({_id:req.params.id,userId:req.user.id});if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});ok(res,await Experiment.find({ideaId:req.params.id,userId:req.user.id}).sort({createdAt:-1}));}));
app.post('/api/experiments/:id/results',asyncRoute(async(req,res)=>{const exp=await Experiment.findOne({_id:req.params.id,userId:req.user.id});if(!exp)return res.status(404).json({error:{code:'NOT_FOUND',message:'Experiment not found.'}});const input=z.object({observations:text(4000).min(1),metricValue:text(300).optional(),outcome:z.enum(['supported','contradicted','inconclusive']).optional(),evidenceIds:z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(20).optional(),limitations:text(1000).optional()}).parse(req.body);if(input.evidenceIds?.length){const count=await Evidence.countDocuments({_id:{$in:input.evidenceIds},userId:req.user.id,archivedAt:null});if(count!==new Set(input.evidenceIds).size)return res.status(404).json({error:{code:'NOT_FOUND',message:'One or more evidence records were not found.'}});}const result=await ExperimentResult.create({...input,experimentId:exp.id,userId:req.user.id});exp.status='recorded';await exp.save();await Idea.findOneAndUpdate({_id:exp.ideaId,userId:req.user.id},{status:input.outcome||'test_recorded'});ok(res,result,201);}));
app.get('/api/opportunities',asyncRoute(async(_req,res)=>ok(res,await Opportunity.find({status:'published'}))));
app.post('/api/match/calculate',asyncRoute(async(req,res)=>{const [user,evidence,opportunity]=await Promise.all([User.findById(req.user.id),Evidence.find({userId:req.user.id,archivedAt:null}),Opportunity.findOne({_id:req.body?.opportunityId,status:'published'})]);if(!user)return res.status(404).json({error:{code:'NOT_FOUND',message:'User not found.'}});if(!opportunity)return res.status(404).json({error:{code:'NOT_FOUND',message:'Opportunity not found.'}});const submissions=await Submission.find({userId:req.user.id}).select('_id');const reviews=await Review.find({submissionId:{$in:submissions.map(s=>s._id)}}).populate({path:'submissionId',populate:{path:'attemptId',populate:{path:'taskId',select:'requiredSkills'}}});const required=new Set((opportunity.requiredSkills||[]).map(s=>s.trim().toLowerCase()));const relevantReviews=reviews.filter(r=>{const attempt=r.submissionId?.attemptId;const skills=attempt?.taskSnapshot?.requiredSkills||attempt?.taskId?.requiredSkills||[];return skills.some(s=>required.has(s.trim().toLowerCase()));});const scores=relevantReviews.flatMap(r=>r.rubricScores.map(s=>({score:s.score,max:s.maxScore}))).filter(s=>s.max>0);const taskPerformance=scores.length?scores.reduce((sum,s)=>sum+s.score/s.max,0)/scores.length:0;const result=calculateMatch(user.profile,evidence,opportunity,taskPerformance);const saved=await MatchResult.create({userId:req.user.id,opportunityId:opportunity.id,...result});ok(res,saved,201);}));
app.get('/api/matches/me',asyncRoute(async(req,res)=>ok(res,await MatchResult.find({userId:req.user.id}).populate('opportunityId').sort({calculatedAt:-1}))));
app.get('/api/applications/me',asyncRoute(async(req,res)=>ok(res,await Application.find({userId:req.user.id}).sort({createdAt:-1}).populate('opportunityId'))));
app.post('/api/opportunities/:id/applications',asyncRoute(async(req,res)=>{if(!await Opportunity.exists({_id:req.params.id,status:'published'}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Opportunity not found.'}});const application=await Application.create({userId:req.user.id,opportunityId:req.params.id,message:z.string().max(1000).optional().parse(req.body?.message)||''});ok(res,application,201);}));
app.use('/api',(_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'API route not found.'}}));
app.use((err,req,res,_next)=>{if(err?.type==='entity.parse.failed')return res.status(400).json({error:{code:'INVALID_JSON',message:'Request body must contain valid JSON.'}});if(err?.type==='entity.too.large')return res.status(413).json({error:{code:'PAYLOAD_TOO_LARGE',message:'Request body is too large.'}});if(err instanceof z.ZodError)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'Please check the submitted fields.',details:err.issues.map(i=>({path:i.path.join('.'),message:i.message}))}});if(err?.code===11000)return res.status(409).json({error:{code:'CONFLICT',message:'This record already exists.'}});if(err?.name==='CastError')return res.status(400).json({error:{code:'INVALID_ID',message:'Record ID is invalid.'}});console.error('API error',err?.message);res.status(500).json({error:{code:'INTERNAL_ERROR',message:'Something went wrong. Please try again.'}});});
