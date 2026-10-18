import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User } from './models/User.js';
import { Project, Evidence, Task, Attempt, Submission, VerificationRun, Review, Appeal } from './models/Work.js';
import { Idea, IdeaAnalysis, IdeaResearch, Experiment, ExperimentResult, Opportunity, MatchResult, Application } from './models/Venture.js';
import { ProfileShare } from './models/Sharing.js';
import { Brief, Invitation, ResourceSwap, Team, TeamInvitation } from './models/Collaboration.js';
import { RepositoryCheck } from './models/RepositoryCheck.js';
import { ReviewSuggestion } from './models/ReviewSuggestion.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { deconstructIdea, draftBusinessBrief, draftTrialTask } from './services/gemini.service.js';
import { calculateMatch, getSkillGapRecommendations } from './services/matching.service.js';
import { buildDashboardSummary } from './services/dashboard.service.js';
import { canSubmitAttempt } from './services/submission.service.js';
import { fetchPublicGithubMetadata } from './services/github.service.js';
import { suggestRubricScores } from './services/review-assist.service.js';

export const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by'); app.use(helmet()); app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' })); app.use(express.json({ limit: '128kb' }));
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control','no-store'); next(); });
const limited = (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } });
const keyByIp = (req) => ipKeyGenerator(req.ip);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited, keyGenerator: keyByIp });
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited, keyGenerator: keyByIp });
const githubCheckLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited, keyGenerator: keyByIp });
const ok = (res, data, status=200) => res.status(status).json({ data });
const cleanUser = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, status: u.status, profile: u.profile });
const asyncRoute = (fn) => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const text = (max) => z.string().trim().max(max);
const canAccessTask = async (user,task) => task.visibility!=='invite_only'||String(task.ownerId)===user.id||Boolean(await Invitation.exists({briefId:task.briefId,recipientId:user.id,status:'accepted'}))||Boolean(await Team.exists({briefId:task.briefId,status:'open','members.userId':user.id}));
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
app.post('/api/talent-board/consent',requireRole('student'),asyncRoute(async(req,res)=>{const user=await User.findByIdAndUpdate(req.user.id,{$set:{'profile.talentBoardConsentAt':new Date()}},{new:true});ok(res,{enabled:true,consentedAt:user.profile.talentBoardConsentAt});}));
app.delete('/api/talent-board/consent',requireRole('student'),asyncRoute(async(req,res)=>{await User.findByIdAndUpdate(req.user.id,{$set:{'profile.talentBoardConsentAt':null}});ok(res,{enabled:false});}));
app.get('/api/talent-board/candidates',requireRole('reviewer','mentor','admin'),asyncRoute(async(req,res)=>{
  const querySchema=z.object({skill:text(60).optional(),location:text(100).optional(),preferredRole:text(100).optional(),limit:z.coerce.number().int().min(1).max(50).default(25)}).strict();
  const query=querySchema.parse(req.query);
  const escaped=(value)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const filter={role:'student',status:'active','profile.talentBoardConsentAt':{$type:'date'}};
  if(query.skill)filter['profile.skills.name']={$regex:`^${escaped(query.skill)}$`,$options:'i'};
  if(query.location)filter['profile.location']={$regex:escaped(query.location),$options:'i'};
  if(query.preferredRole)filter['profile.preferredRole']={$regex:escaped(query.preferredRole),$options:'i'};
  const candidates=await User.find(filter).select('name profile.displayName profile.bio profile.preferredRole profile.location profile.skills profile.talentBoardConsentAt').sort({'profile.talentBoardConsentAt':-1}).limit(query.limit).lean();
  ok(res,candidates.map(candidate=>({id:candidate._id,name:candidate.profile?.displayName||candidate.name,bio:candidate.profile?.bio||'',preferredRole:candidate.profile?.preferredRole||'',location:candidate.profile?.location||'',skills:(candidate.profile?.skills||[]).map(({name,proficiency})=>({name,proficiency})),consentedAt:candidate.profile?.talentBoardConsentAt})));
}));
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
app.get('/api/projects/:id/repository-checks',asyncRoute(async(req,res)=>{
  if(!await Project.exists({_id:req.params.id,userId:req.user.id,archivedAt:null}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Project not found.'}});
  ok(res,await RepositoryCheck.find({projectId:req.params.id,userId:req.user.id}).sort({checkedAt:-1}).limit(20));
}));
app.post('/api/projects/:id/repository-checks',githubCheckLimiter,asyncRoute(async(req,res)=>{
  const project=await Project.findOne({_id:req.params.id,userId:req.user.id,archivedAt:null});
  if(!project)return res.status(404).json({error:{code:'NOT_FOUND',message:'Project not found.'}});
  if(!project.repositoryUrl)return res.status(400).json({error:{code:'REPOSITORY_URL_REQUIRED',message:'Add a GitHub repository URL to this project first.'}});
  const metadata=await fetchPublicGithubMetadata(project.repositoryUrl);
  const check=await RepositoryCheck.create({userId:req.user.id,projectId:project.id,...metadata});
  ok(res,{check,meaning:'Confirms only that GitHub returned public repository metadata. It does not verify ownership, authorship, commit history, code quality, or project claims.'},201);
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
const taskPatchSchema=taskSchema.partial().extend({requiredSkills:z.array(text(60).min(1)).max(30).optional(),status:z.enum(['draft','published']).optional()}).strict().refine(value=>Object.keys(value).length>0);
app.post('/api/admin/tasks/generate-draft',requireRole('admin'),aiLimiter,asyncRoute(async(req,res)=>{
  const input=z.object({title:text(120).min(1),goal:text(500).min(1),context:text(4000).min(1),role:text(80).optional()}).strict().parse(req.body);
  const generated=await draftTrialTask(input);
  const task=await Task.create({title:input.title,...generated.data,status:'draft',draftSource:generated.source,promptVersion:generated.promptVersion,version:1});
  ok(res,{task,generation:{source:generated.source,model:generated.model,promptVersion:generated.promptVersion,fallbackReason:generated.fallbackReason||null,notice:generated.source==='sample'?'Sample task draft — not generated live. Review and edit before publishing.':'AI-generated task proposal — review and edit before publishing.'}},201);
}));
app.get('/api/admin/tasks',requireRole('admin'),asyncRoute(async(_req,res)=>ok(res,await Task.find({}).sort({updatedAt:-1}))));
app.post('/api/admin/tasks',requireRole('admin'),asyncRoute(async(req,res)=>{const fields=taskSchema.parse(req.body);const task=await Task.create({...fields,category:fields.category||'General',allowedTools:fields.allowedTools||'Any tools; disclose AI assistance.',version:1,status:fields.status||'draft'});ok(res,task,201);}));
app.patch('/api/admin/tasks/:id',requireRole('admin'),asyncRoute(async(req,res)=>{
  const fields=taskPatchSchema.parse(req.body);
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
app.get('/api/founder/tasks',requireRole('founder'),asyncRoute(async(req,res)=>ok(res,await Task.find({ownerId:req.user.id,status:{$ne:'archived'}}).sort({updatedAt:-1}))));
app.post('/api/founder/tasks',requireRole('founder'),asyncRoute(async(req,res)=>{
  const fields=taskSchema.parse(req.body);
  const task=await Task.create({...fields,category:fields.category||'General',allowedTools:fields.allowedTools||'Any tools; disclose AI assistance.',ownerId:req.user.id,visibility:'public',version:1,status:fields.status||'published'});
  ok(res,task,201);
}));
app.patch('/api/founder/tasks/:id',requireRole('founder'),asyncRoute(async(req,res)=>{
  const fields=taskPatchSchema.parse(req.body);
  const task=await Task.findOne({_id:req.params.id,ownerId:req.user.id,status:{$ne:'archived'}});
  if(!task)return res.status(404).json({error:{code:'NOT_FOUND',message:'Task not found.'}});
  Object.assign(task,fields);
  task.version+=1;
  await task.save();
  ok(res,task);
}));
app.delete('/api/founder/tasks/:id',requireRole('founder'),asyncRoute(async(req,res)=>{
  const task=await Task.findOne({_id:req.params.id,ownerId:req.user.id,status:{$ne:'archived'}});
  if(!task)return res.status(404).json({error:{code:'NOT_FOUND',message:'Task not found.'}});
  task.status='archived';
  task.version+=1;
  await task.save();
  ok(res,{id:task.id,status:task.status,version:task.version});
}));
app.get('/api/tasks',requireRole('student'),asyncRoute(async(req,res)=>{const invitations=await Invitation.find({recipientId:req.user.id,status:'accepted'}).select('briefId');const briefIds=invitations.map(item=>item.briefId);ok(res,await Task.find({status:'published',$or:[{visibility:'public'},{visibility:{$exists:false}},{ownerId:req.user.id},{briefId:{$in:briefIds}}]}).sort({createdAt:-1}));}));
app.get('/api/tasks/:id',requireRole('student'),asyncRoute(async(req,res)=>{const task=await Task.findOne({_id:req.params.id,status:'published'});if(!task||!await canAccessTask(req.user,task))return res.status(404).json({error:{code:'NOT_FOUND',message:'Task not found.'}});ok(res,task);}));
app.post('/api/tasks/:id/attempts',requireRole('student'),asyncRoute(async(req,res)=>{
  const task=await Task.findOne({_id:req.params.id,status:'published'});
  if(!task||!await canAccessTask(req.user,task))return res.status(404).json({error:{code:'NOT_FOUND',message:'Task not found.'}});
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
app.post('/api/submissions/:id/score-suggestions',requireRole('reviewer','admin'),aiLimiter,asyncRoute(async(req,res)=>{
  z.object({confirmShareWithGemini:z.literal(true)}).strict().parse(req.body);
  const sub=await Submission.findById(req.params.id);
  if(!sub||sub.isSample)return res.status(404).json({error:{code:'NOT_FOUND',message:'Reviewable submission not found.'}});
  if(String(sub.userId)===req.user.id)return res.status(403).json({error:{code:'FORBIDDEN',message:'You cannot request review assistance for your own submission.'}});
  if(!['submitted','checks_passed','needs_review'].includes(sub.status))return res.status(409).json({error:{code:'INVALID_STATUS',message:'This submission is not awaiting review.'}});
  const attempt=await Attempt.findOne({_id:sub.attemptId,userId:sub.userId});
  const currentTask=attempt?await Task.findById(attempt.taskId):null;
  const task=attempt?.taskSnapshot||currentTask;
  if(!task?.rubric?.length)return res.status(404).json({error:{code:'NOT_FOUND',message:'Task rubric not found.'}});
  const suggestion=await suggestRubricScores(task,sub);
  const notice=suggestion.source==='gemini'?'AI suggestions are advisory. Verify each rationale and set the final human review yourself.':'Sample notice — Gemini was unavailable; no scores were generated.';
  const saved=await ReviewSuggestion.create({submissionId:sub.id,reviewerId:req.user.id,...suggestion,notice});
  ok(res,{suggestion:saved,changesSubmissionStatus:false,requiresHumanReview:true},201);
}));
app.get('/api/submissions/:id/score-suggestions',requireRole('reviewer','admin'),asyncRoute(async(req,res)=>{
  if(!await Submission.exists({_id:req.params.id,isSample:{$ne:true}}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Submission not found.'}});
  ok(res,await ReviewSuggestion.find({submissionId:req.params.id}).sort({createdAt:-1}));
}));
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
const ideaSchema=z.object({title:text(120).min(1),description:text(5000).min(1),targetCustomer:text(500).optional(),problem:text(1000).optional(),proposedSolution:text(1000).optional(),alternatives:text(1000).optional()}).strict();
app.get('/api/ideas',asyncRoute(async(req,res)=>ok(res,await Idea.find({userId:req.user.id}).sort({updatedAt:-1}))));
app.post('/api/ideas',asyncRoute(async(req,res)=>{const idea=await Idea.create({...ideaSchema.parse(req.body),userId:req.user.id});ok(res,idea,201);}));
app.get('/api/ideas/:id',asyncRoute(async(req,res)=>{const idea=await Idea.findOne({_id:req.params.id,userId:req.user.id});return idea?ok(res,idea):res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});}));
app.patch('/api/ideas/:id',asyncRoute(async(req,res)=>{const fields=ideaSchema.partial().refine(value=>Object.keys(value).length>0).parse(req.body);const idea=await Idea.findOne({_id:req.params.id,userId:req.user.id});if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});Object.assign(idea,fields);await idea.save();ok(res,idea);}));
app.post('/api/ideas/:id/research',asyncRoute(async(req,res)=>{
  const idea=await Idea.findOne({_id:req.params.id,userId:req.user.id});
  if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});
  const input=z.object({evidenceIds:z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(20),notes:text(2000).optional()}).strict().parse(req.body);
  const evidenceIds=[...new Set(input.evidenceIds)];
  if(evidenceIds.length!==input.evidenceIds.length)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'Evidence records cannot be repeated.'}});
  if(await Evidence.countDocuments({_id:{$in:evidenceIds},userId:req.user.id,archivedAt:null,provenance:{$ne:'sample'}})!==evidenceIds.length)return res.status(404).json({error:{code:'NOT_FOUND',message:'One or more evidence records were not found.'}});
  const research=await IdeaResearch.create({ideaId:idea.id,userId:req.user.id,evidenceIds,notes:input.notes||''});
  if(idea.status==='guess')idea.status='researched';
  await idea.save();
  ok(res,{research,ideaStatus:idea.status},201);
}));
app.get('/api/ideas/:id/research',asyncRoute(async(req,res)=>{const idea=await Idea.exists({_id:req.params.id,userId:req.user.id});if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});ok(res,await IdeaResearch.find({ideaId:req.params.id,userId:req.user.id}).sort({createdAt:-1}).populate('evidenceIds','title type sourceUrl provenance status'));}));
app.post('/api/venture/deconstruct',aiLimiter,asyncRoute(async(req,res)=>{
  const idea=await Idea.findOne({_id:z.string().regex(/^[a-f\d]{24}$/i).parse(req.body?.ideaId),userId:req.user.id});
  if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});
  const generated=await deconstructIdea(idea);
  const saved=await IdeaAnalysis.create({ideaId:idea.id,userId:req.user.id,model:generated.model,source:generated.source,promptVersion:generated.promptVersion||'1',...generated.data});
  const experiments=[];
  for(const item of generated.data.experiments){
    let experiment=await Experiment.findOne({userId:req.user.id,ideaId:idea.id,hypothesis:item.hypothesis});
    if(!experiment)experiment=await Experiment.create({...item,ideaId:idea.id,userId:req.user.id,status:'planned'});
    experiments.push(experiment);
  }
  if(['guess','researched'].includes(idea.status))idea.status='test_planned';
  await idea.save();
  const notice=generated.source==='sample'?(generated.fallbackReason?'Gemini was unavailable. Sample response — not generated live. Your saved idea is safe; retry later or continue manually.':'Sample response — not generated live. Configure GEMINI_API_KEY for live analysis.'):'AI-generated suggestions, not verified facts or market research.';
  ok(res,{analysis:saved,experiments,notice},201);
}));
app.get('/api/ideas/:id/analyses',asyncRoute(async(req,res)=>{const idea=await Idea.exists({_id:req.params.id,userId:req.user.id});if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});ok(res,await IdeaAnalysis.find({ideaId:req.params.id,userId:req.user.id}).sort({createdAt:-1}));}));
app.get('/api/ideas/:id/results',asyncRoute(async(req,res)=>{const idea=await Idea.exists({_id:req.params.id,userId:req.user.id});if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});const experiments=await Experiment.find({ideaId:req.params.id,userId:req.user.id}).select('_id');ok(res,await ExperimentResult.find({experimentId:{$in:experiments.map(e=>e._id)},userId:req.user.id}).sort({createdAt:-1}));}));
app.get('/api/ideas/:id/experiments',asyncRoute(async(req,res)=>{const idea=await Idea.exists({_id:req.params.id,userId:req.user.id});if(!idea)return res.status(404).json({error:{code:'NOT_FOUND',message:'Idea not found.'}});ok(res,await Experiment.find({ideaId:req.params.id,userId:req.user.id}).sort({createdAt:-1}));}));
app.post('/api/experiments/:id/results',asyncRoute(async(req,res)=>{const exp=await Experiment.findOne({_id:req.params.id,userId:req.user.id});if(!exp)return res.status(404).json({error:{code:'NOT_FOUND',message:'Experiment not found.'}});const input=z.object({observations:text(4000).min(1),metricValue:text(300).optional(),outcome:z.enum(['supported','contradicted','inconclusive']).optional(),evidenceIds:z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(20).optional(),limitations:text(1000).optional()}).parse(req.body);if(input.evidenceIds?.length){const count=await Evidence.countDocuments({_id:{$in:input.evidenceIds},userId:req.user.id,archivedAt:null});if(count!==new Set(input.evidenceIds).size)return res.status(404).json({error:{code:'NOT_FOUND',message:'One or more evidence records were not found.'}});}const result=await ExperimentResult.create({...input,experimentId:exp.id,userId:req.user.id});exp.status='recorded';await exp.save();await Idea.findOneAndUpdate({_id:exp.ideaId,userId:req.user.id},{status:input.outcome||'test_recorded'});ok(res,result,201);}));
const briefSchema=z.object({title:text(160).min(1),problem:text(4000).min(1),desiredOutcome:text(2000).min(1),constraints:text(2000).optional(),effortEstimate:text(200).optional(),requiredSkills:z.array(text(60).min(1)).max(30).default([]),deliverables:z.array(z.object({name:text(120).min(1),required:z.boolean().default(true),instructions:text(1000).optional()}).strict()).min(1).max(20),rubric:z.array(z.object({criterion:text(120).min(1),points:z.number().positive(),description:text(1000).min(1)}).strict()).min(1).max(20),allowedTools:text(500).optional(),source:z.enum(['owner','ai']).optional()}).strict();
app.post('/api/briefs/generate-draft',requireRole('founder','admin'),aiLimiter,asyncRoute(async(req,res)=>{
  const input=z.object({title:text(160).min(1),context:text(4000).min(1),desiredOutcome:text(2000).optional(),constraints:text(2000).optional()}).strict().parse(req.body);
  const generated=await draftBusinessBrief(input);
  const brief=await Brief.create({ownerId:req.user.id,title:input.title,...generated.data,status:'draft',source:'ai',draftOrigin:generated.source,promptVersion:generated.promptVersion,version:1});
  ok(res,{brief,generation:{source:generated.source,model:generated.model,promptVersion:generated.promptVersion,fallbackReason:generated.fallbackReason||null,notice:generated.source==='sample'?'Sample draft template — not generated live. Review and edit it before submitting for admin approval.':'AI-generated draft proposal — review and edit it before submitting for admin approval.'}},201);
}));
app.get('/api/briefs',asyncRoute(async(_req,res)=>ok(res,await Brief.find({status:'published'}).select('title desiredOutcome effortEstimate requiredSkills version createdAt').sort({createdAt:-1}))));
app.get('/api/briefs/me',requireRole('founder','admin'),asyncRoute(async(req,res)=>ok(res,await Brief.find(req.user.role==='admin'?{}:{ownerId:req.user.id}).sort({updatedAt:-1}))));
app.post('/api/briefs',requireRole('founder','admin'),asyncRoute(async(req,res)=>{const input=briefSchema.parse(req.body);ok(res,await Brief.create({...input,ownerId:req.user.id,status:'draft',version:1,source:input.source||'owner'}),201);}));
app.get('/api/briefs/:id',asyncRoute(async(req,res)=>{
  const brief=await Brief.findById(req.params.id);
  if(!brief)return res.status(404).json({error:{code:'NOT_FOUND',message:'Brief not found.'}});
  const isOwner=String(brief.ownerId)===req.user.id||req.user.role==='admin';
  const hasAcceptedInvite=brief.status==='published'&&await Invitation.exists({briefId:brief.id,recipientId:req.user.id,status:'accepted'});
  if(!isOwner&&!hasAcceptedInvite)return res.status(404).json({error:{code:'NOT_FOUND',message:'Brief not found.'}});
  ok(res,brief);
}));
app.patch('/api/briefs/:id',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const fields=briefSchema.partial().extend({requiredSkills:z.array(text(60).min(1)).max(30).optional()}).strict().refine(value=>Object.keys(value).length>0).parse(req.body);
  const brief=await Brief.findOne({_id:req.params.id,status:'draft'});
  if(!brief||req.user.role!=='admin'&&String(brief.ownerId)!==req.user.id)return res.status(404).json({error:{code:'NOT_FOUND',message:'Draft brief not found.'}});
  Object.assign(brief,fields);
  brief.version+=1;
  brief.approvedBy=undefined;
  brief.approvedAt=undefined;
  await brief.save();
  ok(res,brief);
}));
app.post('/api/briefs/:id/approve',requireRole('admin'),asyncRoute(async(req,res)=>{
  const brief=await Brief.findOne({_id:req.params.id,status:'draft'});
  if(!brief)return res.status(404).json({error:{code:'NOT_FOUND',message:'Draft brief not found.'}});
  brief.approvedBy=req.user.id;
  brief.approvedAt=new Date();
  await brief.save();
  ok(res,{id:brief.id,approvedAt:brief.approvedAt});
}));
app.post('/api/briefs/:id/publish',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const brief=await Brief.findOne({_id:req.params.id,status:'draft'});
  if(!brief||req.user.role!=='admin'&&String(brief.ownerId)!==req.user.id)return res.status(404).json({error:{code:'NOT_FOUND',message:'Draft brief not found.'}});
  if(brief.source==='ai'&&!brief.approvedAt)return res.status(409).json({error:{code:'APPROVAL_REQUIRED',message:'Review and approve the AI-drafted brief before publishing.'}});
  const task=await Task.create({title:brief.title,goal:brief.desiredOutcome,description:[brief.problem,brief.constraints&&`Constraints: ${brief.constraints}`].filter(Boolean).join('\n\n').slice(0,5000),category:'Business brief',difficulty:'Intermediate',requiredSkills:brief.requiredSkills,deliverables:brief.deliverables.map(({name,required})=>({name,required})),rubric:brief.rubric,allowedTools:brief.allowedTools||'Any tools; disclose AI assistance.',visibility:'invite_only',ownerId:brief.ownerId,briefId:brief.id,version:brief.version,status:'published'});
  brief.status='published';
  brief.taskId=task.id;
  await brief.save();
  ok(res,{brief,task},200);
}));
app.delete('/api/briefs/:id',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const brief=await Brief.findOne({_id:req.params.id,status:{$ne:'archived'}});
  if(!brief||req.user.role!=='admin'&&String(brief.ownerId)!==req.user.id)return res.status(404).json({error:{code:'NOT_FOUND',message:'Brief not found.'}});
  brief.status='archived';
  if(brief.taskId)await Task.findByIdAndUpdate(brief.taskId,{status:'archived'});
  await Invitation.updateMany({briefId:brief.id,status:'pending'},{$set:{status:'cancelled',decidedAt:new Date()}});
  await brief.save();
  ok(res,{id:brief.id,status:brief.status});
}));
app.post('/api/briefs/:id/invitations',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const brief=await Brief.findOne({_id:req.params.id,status:'published'});
  if(!brief||req.user.role!=='admin'&&String(brief.ownerId)!==req.user.id)return res.status(404).json({error:{code:'NOT_FOUND',message:'Published brief not found.'}});
  const input=z.object({recipientId:z.string().regex(/^[a-f\d]{24}$/i),message:text(1000).optional()}).strict().parse(req.body);
  if(input.recipientId===req.user.id)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'You cannot invite yourself.'}});
  if(!await User.exists({_id:input.recipientId,status:'active'}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Candidate account not found.'}});
  ok(res,await Invitation.create({briefId:brief.id,taskId:brief.taskId,senderId:req.user.id,recipientId:input.recipientId,briefVersion:brief.version,message:input.message||''}),201);
}));
app.get('/api/invitations/me',asyncRoute(async(req,res)=>ok(res,await Invitation.find({recipientId:req.user.id}).sort({createdAt:-1}).populate('briefId','title desiredOutcome version status'))));
app.post('/api/invitations/:id/respond',asyncRoute(async(req,res)=>{
  const input=z.object({status:z.enum(['accepted','declined'])}).strict().parse(req.body);
  const invitation=await Invitation.findOne({_id:req.params.id,recipientId:req.user.id,status:'pending'});
  if(!invitation)return res.status(404).json({error:{code:'NOT_FOUND',message:'Pending invitation not found.'}});
  invitation.status=input.status;
  invitation.decidedAt=new Date();
  if(input.status==='accepted')invitation.consentAt=new Date();
  await invitation.save();
  ok(res,invitation);
}));
app.post('/api/teams',requireRole('student'),asyncRoute(async(req,res)=>{
  const input=z.object({briefId:z.string().regex(/^[a-f\d]{24}$/i),name:text(120).min(1),goal:text(1000).min(1),requiredSkills:z.array(text(60).min(1)).max(20).default([]),maxMembers:z.number().int().min(2).max(8).default(4)}).strict().parse(req.body);
  const brief=await Brief.findOne({_id:input.briefId,status:'published'});
  if(!brief||!await Invitation.exists({briefId:brief.id,recipientId:req.user.id,status:'accepted'}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Accepted brief not found.'}});
  const team=await Team.create({...input,ownerId:req.user.id,members:[{userId:req.user.id,role:'Team lead'}]});
  ok(res,team,201);
}));
app.get('/api/teams/me',requireRole('student'),asyncRoute(async(req,res)=>ok(res,await Team.find({'members.userId':req.user.id}).sort({updatedAt:-1}).populate('briefId','title desiredOutcome status').populate('members.userId','name profile.displayName profile.skills.name'))));
app.get('/api/teams/:id',requireRole('student'),asyncRoute(async(req,res)=>{
  const team=await Team.findOne({_id:req.params.id,'members.userId':req.user.id}).populate('briefId','title desiredOutcome status').populate('members.userId','name profile.displayName profile.skills.name');
  return team?ok(res,team):res.status(404).json({error:{code:'NOT_FOUND',message:'Team not found.'}});
}));
app.get('/api/teams/:id/submissions',requireRole('student'),asyncRoute(async(req,res)=>{
  const team=await Team.findOne({_id:req.params.id,status:'open','members.userId':req.user.id});
  if(!team)return res.status(404).json({error:{code:'NOT_FOUND',message:'Open team not found.'}});
  const brief=await Brief.findOne({_id:team.briefId,status:'published'}).select('taskId version');
  if(!brief?.taskId)return ok(res,{briefVersion:brief?.version||null,members:team.members,submissions:[]});
  const attempts=await Attempt.find({taskId:brief.taskId,userId:{$in:team.members.map(member=>member.userId)}}).select('_id userId taskVersion status startedAt submittedAt');
  const submissions=await Submission.find({attemptId:{$in:attempts.map(attempt=>attempt._id)}}).sort({submittedAt:1}).populate('attemptId','userId taskVersion status');
  ok(res,{briefVersion:brief.version,members:team.members,submissions});
}));
app.post('/api/teams/:id/invitations',requireRole('student'),asyncRoute(async(req,res)=>{
  const team=await Team.findOne({_id:req.params.id,ownerId:req.user.id,status:'open'});
  if(!team)return res.status(404).json({error:{code:'NOT_FOUND',message:'Open team not found.'}});
  if(team.members.length>=team.maxMembers)return res.status(409).json({error:{code:'TEAM_FULL',message:'This team has reached its member limit.'}});
  const input=z.object({recipientId:z.string().regex(/^[a-f\d]{24}$/i),teamRole:text(80).min(1).default('Contributor')}).strict().parse(req.body);
  if(input.recipientId===req.user.id||team.members.some(member=>String(member.userId)===input.recipientId))return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'This user is already part of the team.'}});
  if(!await User.exists({_id:input.recipientId,role:'student',status:'active'}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Active student account not found.'}});
  ok(res,await TeamInvitation.create({teamId:team.id,senderId:req.user.id,recipientId:input.recipientId,teamRole:input.teamRole}),201);
}));
app.get('/api/team-invitations/me',requireRole('student'),asyncRoute(async(req,res)=>ok(res,await TeamInvitation.find({recipientId:req.user.id}).sort({createdAt:-1}).populate({path:'teamId',select:'briefId ownerId name goal requiredSkills maxMembers status'}))));
app.post('/api/team-invitations/:id/respond',requireRole('student'),asyncRoute(async(req,res)=>{
  const input=z.object({status:z.enum(['accepted','declined'])}).strict().parse(req.body);
  const invitation=await TeamInvitation.findOne({_id:req.params.id,recipientId:req.user.id,status:'pending'});
  if(!invitation)return res.status(404).json({error:{code:'NOT_FOUND',message:'Pending team invitation not found.'}});
  if(input.status==='declined'){
    invitation.status='declined';invitation.decidedAt=new Date();await invitation.save();return ok(res,invitation);
  }
  const team=await Team.findById(invitation.teamId);
  if(!team||team.status!=='open')return res.status(409).json({error:{code:'TEAM_CLOSED',message:'This team is no longer open.'}});
  const addMember=await Team.updateOne({_id:team.id,status:'open','members.userId':{$ne:req.user.id},$expr:{$lt:[{$size:'$members'},'$maxMembers']}},{$push:{members:{userId:req.user.id,role:invitation.teamRole,joinedAt:new Date()}}});
  if(!addMember.modifiedCount)return res.status(409).json({error:{code:'TEAM_FULL',message:'This team is full or no longer open.'}});
  try{
    if(!await Brief.exists({_id:team.briefId,status:'published'}))throw Object.assign(new Error('Brief is no longer available.'),{status:409,code:'BRIEF_CLOSED'});
    invitation.status='accepted';invitation.consentAt=new Date();invitation.decidedAt=new Date();await invitation.save();
  }catch(error){await Team.updateOne({_id:team.id},{$pull:{members:{userId:req.user.id}}});throw error;}
  ok(res,{invitation,team:await Team.findById(team.id)});
}));
app.post('/api/teams/:id/leave',requireRole('student'),asyncRoute(async(req,res)=>{
  const team=await Team.findOne({_id:req.params.id,'members.userId':req.user.id});
  if(!team)return res.status(404).json({error:{code:'NOT_FOUND',message:'Team not found.'}});
  if(String(team.ownerId)===req.user.id)return res.status(409).json({error:{code:'OWNER_CANNOT_LEAVE',message:'The team owner must close the team instead.'}});
  await Team.updateOne({_id:team.id},{$pull:{members:{userId:req.user.id}}});
  ok(res,{teamId:team.id,left:true});
}));
app.post('/api/teams/:id/close',requireRole('student'),asyncRoute(async(req,res)=>{
  const team=await Team.findOneAndUpdate({_id:req.params.id,ownerId:req.user.id,status:'open'},{$set:{status:'closed'}},{new:true});
  if(!team)return res.status(404).json({error:{code:'NOT_FOUND',message:'Open team not found.'}});
  await TeamInvitation.updateMany({teamId:team.id,status:'pending'},{$set:{status:'cancelled',decidedAt:new Date()}});
  ok(res,{id:team.id,status:team.status});
}));
app.get('/api/briefs/:id/submissions',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const brief=await Brief.findById(req.params.id);
  if(!brief||req.user.role!=='admin'&&String(brief.ownerId)!==req.user.id)return res.status(404).json({error:{code:'NOT_FOUND',message:'Brief not found.'}});
  if(!brief.taskId)return ok(res,{briefVersion:brief.version,submissions:[]});
  const attempts=await Attempt.find({taskId:brief.taskId}).select('_id userId taskVersion status startedAt submittedAt');
  const submissions=await Submission.find({attemptId:{$in:attempts.map(item=>item._id)}}).sort({submittedAt:1}).populate('attemptId','userId taskVersion status');
  ok(res,{briefVersion:brief.version,submissions});
}));
app.post('/api/resource-swaps',asyncRoute(async(req,res)=>{
  const input=z.object({recipientId:z.string().regex(/^[a-f\d]{24}$/i),offer:text(2000).min(1),request:text(2000).min(1),terms:text(2000).min(1)}).strict().parse(req.body);
  if(input.recipientId===req.user.id)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'A resource swap needs another participant.'}});
  if(!await User.exists({_id:input.recipientId,status:'active'}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Recipient account not found.'}});
  ok(res,await ResourceSwap.create({...input,proposerId:req.user.id,status:'proposed'}),201);
}));
app.get('/api/resource-swaps/me',asyncRoute(async(req,res)=>ok(res,await ResourceSwap.find({$or:[{proposerId:req.user.id},{recipientId:req.user.id}]}).sort({createdAt:-1}))));
app.get('/api/resource-swaps/:id',asyncRoute(async(req,res)=>{const swap=await ResourceSwap.findOne({_id:req.params.id,$or:[{proposerId:req.user.id},{recipientId:req.user.id}]});return swap?ok(res,swap):res.status(404).json({error:{code:'NOT_FOUND',message:'Resource swap not found.'}});}));
app.post('/api/resource-swaps/:id/respond',asyncRoute(async(req,res)=>{
  const input=z.object({status:z.enum(['accepted','declined'])}).strict().parse(req.body);
  const swap=await ResourceSwap.findOne({_id:req.params.id,recipientId:req.user.id,status:'proposed'});
  if(!swap)return res.status(404).json({error:{code:'NOT_FOUND',message:'Pending resource swap not found.'}});
  swap.status=input.status;
  await swap.save();
  ok(res,swap);
}));
app.post('/api/resource-swaps/:id/confirm',asyncRoute(async(req,res)=>{
  const swap=await ResourceSwap.findOne({_id:req.params.id,$or:[{proposerId:req.user.id},{recipientId:req.user.id}]});
  if(!swap)return res.status(404).json({error:{code:'NOT_FOUND',message:'Resource swap not found.'}});
  if(swap.status!=='accepted')return res.status(409).json({error:{code:'INVALID_STATUS',message:'Both parties must accept the exchange before confirming completion.'}});
  if(!swap.confirmations.some(item=>String(item.userId)===req.user.id))swap.confirmations.push({userId:req.user.id,confirmedAt:new Date()});
  if(new Set(swap.confirmations.map(item=>String(item.userId))).size===2)swap.status='completed';
  await swap.save();
  ok(res,swap);
}));
app.post('/api/resource-swaps/:id/cancel',asyncRoute(async(req,res)=>{
  const swap=await ResourceSwap.findOne({_id:req.params.id,$or:[{proposerId:req.user.id},{recipientId:req.user.id}]});
  if(!swap)return res.status(404).json({error:{code:'NOT_FOUND',message:'Resource swap not found.'}});
  if(!['proposed','accepted'].includes(swap.status))return res.status(409).json({error:{code:'INVALID_STATUS',message:'This resource swap cannot be cancelled.'}});
  swap.status='cancelled';
  await swap.save();
  ok(res,swap);
}));
const opportunitySchema=z.object({title:text(160).min(1),provider:text(160).min(1),description:text(4000).min(1),roleType:text(80).optional(),requiredSkills:z.array(text(60).min(1)).max(40).default([]),eligibility:z.array(text(300).min(1)).max(30).default([]),remote:z.boolean().optional(),location:text(160).optional(),status:z.enum(['draft','published']).optional()}).strict();
const opportunityPatchSchema=opportunitySchema.partial().extend({requiredSkills:z.array(text(60).min(1)).max(40).optional(),eligibility:z.array(text(300).min(1)).max(30).optional()}).strict().refine(value=>Object.keys(value).length>0);
app.get('/api/opportunities',asyncRoute(async(_req,res)=>ok(res,await Opportunity.find({status:'published'}).sort({createdAt:-1}))));
app.get('/api/opportunities/:id/skill-gaps',asyncRoute(async(req,res)=>{
  const [user,opportunity]=await Promise.all([User.findById(req.user.id).select('profile.skills'),Opportunity.findOne({_id:req.params.id,status:'published'}).select('title requiredSkills')]);
  if(!opportunity)return res.status(404).json({error:{code:'NOT_FOUND',message:'Opportunity not found.'}});
  const tasks=await Task.find({status:'published',$or:[{visibility:'public'},{visibility:{$exists:false}}]}).select('title category difficulty requiredSkills status visibility');
  ok(res,{opportunityId:opportunity.id,opportunityTitle:opportunity.title,...getSkillGapRecommendations(user?.profile||{},opportunity,tasks)});
}));
app.get('/api/owner/opportunities',requireRole('founder','admin'),asyncRoute(async(req,res)=>ok(res,await Opportunity.find(req.user.role==='admin'?{}:{ownerId:req.user.id}).sort({updatedAt:-1}))));
app.post('/api/opportunities',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const input=opportunitySchema.parse(req.body);
  if(req.user.role==='founder'&&input.status&&input.status!=='draft')return res.status(403).json({error:{code:'FORBIDDEN',message:'Only an admin can publish an opportunity.'}});
  const opportunity=await Opportunity.create({...input,ownerId:req.user.id,status:req.user.role==='admin'?(input.status||'draft'):'draft'});
  ok(res,opportunity,201);
}));
app.patch('/api/opportunities/:id',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const fields=opportunityPatchSchema.parse(req.body);
  const opportunity=await Opportunity.findOne({_id:req.params.id,status:{$ne:'closed'}});
  if(!opportunity||req.user.role!=='admin'&&String(opportunity.ownerId)!==req.user.id)return res.status(404).json({error:{code:'NOT_FOUND',message:'Opportunity not found.'}});
  if(req.user.role!=='admin'&&opportunity.status!=='draft')return res.status(409).json({error:{code:'INVALID_STATUS',message:'Only draft opportunities can be edited by their owner.'}});
  if(req.user.role==='founder'&&fields.status)return res.status(403).json({error:{code:'FORBIDDEN',message:'Only an admin can change opportunity publication status.'}});
  Object.assign(opportunity,fields);
  await opportunity.save();
  ok(res,opportunity);
}));
app.delete('/api/opportunities/:id',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const opportunity=await Opportunity.findOne({_id:req.params.id,status:{$ne:'closed'}});
  if(!opportunity||req.user.role!=='admin'&&String(opportunity.ownerId)!==req.user.id)return res.status(404).json({error:{code:'NOT_FOUND',message:'Opportunity not found.'}});
  opportunity.status='closed';
  await opportunity.save();
  ok(res,{id:opportunity.id,status:opportunity.status});
}));
app.get('/api/opportunities/:id/applications',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const opportunity=await Opportunity.findById(req.params.id);
  if(!opportunity||req.user.role!=='admin'&&String(opportunity.ownerId)!==req.user.id)return res.status(404).json({error:{code:'NOT_FOUND',message:'Opportunity not found.'}});
  ok(res,await Application.find({opportunityId:opportunity.id}).sort({createdAt:-1}).select('userId status statusHistory message createdAt updatedAt'));
}));
app.post('/api/match/calculate',asyncRoute(async(req,res)=>{const [user,evidence,opportunity]=await Promise.all([User.findById(req.user.id),Evidence.find({userId:req.user.id,archivedAt:null}),Opportunity.findOne({_id:req.body?.opportunityId,status:'published'})]);if(!user)return res.status(404).json({error:{code:'NOT_FOUND',message:'User not found.'}});if(!opportunity)return res.status(404).json({error:{code:'NOT_FOUND',message:'Opportunity not found.'}});const submissions=await Submission.find({userId:req.user.id}).select('_id');const reviews=await Review.find({submissionId:{$in:submissions.map(s=>s._id)}}).populate({path:'submissionId',populate:{path:'attemptId',populate:{path:'taskId',select:'requiredSkills'}}});const required=new Set((opportunity.requiredSkills||[]).map(s=>s.trim().toLowerCase()));const relevantReviews=reviews.filter(r=>{const attempt=r.submissionId?.attemptId;const skills=attempt?.taskSnapshot?.requiredSkills||attempt?.taskId?.requiredSkills||[];return skills.some(s=>required.has(s.trim().toLowerCase()));});const scores=relevantReviews.flatMap(r=>r.rubricScores.map(s=>({score:s.score,max:s.maxScore}))).filter(s=>s.max>0);const taskPerformance=scores.length?scores.reduce((sum,s)=>sum+s.score/s.max,0)/scores.length:0;const result=calculateMatch(user.profile,evidence,opportunity,taskPerformance);const saved=await MatchResult.create({userId:req.user.id,opportunityId:opportunity.id,...result});ok(res,saved,201);}));
app.get('/api/matches/me',asyncRoute(async(req,res)=>ok(res,await MatchResult.find({userId:req.user.id}).populate('opportunityId').sort({calculatedAt:-1}))));
app.get('/api/applications/me',asyncRoute(async(req,res)=>ok(res,await Application.find({userId:req.user.id}).sort({createdAt:-1}).populate('opportunityId'))));
app.post('/api/opportunities/:id/applications',asyncRoute(async(req,res)=>{if(!await Opportunity.exists({_id:req.params.id,status:'published'}))return res.status(404).json({error:{code:'NOT_FOUND',message:'Opportunity not found.'}});const application=await Application.create({userId:req.user.id,opportunityId:req.params.id,message:z.string().max(1000).optional().parse(req.body?.message)||''});ok(res,application,201);}));
app.patch('/api/applications/:id/status',requireRole('founder','admin'),asyncRoute(async(req,res)=>{
  const input=z.object({status:z.enum(['reviewing','accepted','rejected'])}).strict().parse(req.body);
  const application=await Application.findById(req.params.id);
  if(!application)return res.status(404).json({error:{code:'NOT_FOUND',message:'Application not found.'}});
  const opportunity=await Opportunity.findById(application.opportunityId);
  if(!opportunity||req.user.role!=='admin'&&String(opportunity.ownerId)!==req.user.id)return res.status(404).json({error:{code:'NOT_FOUND',message:'Application not found.'}});
  if(!['submitted','reviewing'].includes(application.status))return res.status(409).json({error:{code:'INVALID_STATUS',message:'This application is already closed.'}});
  const previousStatus=application.status;
  application.statusHistory.push({actorId:req.user.id,fromStatus:previousStatus,toStatus:input.status});
  application.status=input.status;
  await application.save();
  ok(res,application);
}));
app.post('/api/applications/:id/withdraw',asyncRoute(async(req,res)=>{
  const application=await Application.findOne({_id:req.params.id,userId:req.user.id});
  if(!application)return res.status(404).json({error:{code:'NOT_FOUND',message:'Application not found.'}});
  if(!['submitted','reviewing'].includes(application.status))return res.status(409).json({error:{code:'INVALID_STATUS',message:'This application can no longer be withdrawn.'}});
  application.statusHistory.push({actorId:req.user.id,fromStatus:application.status,toStatus:'withdrawn'});
  application.status='withdrawn';
  await application.save();
  ok(res,application);
}));
app.use('/api',(_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'API route not found.'}}));
app.use((err,req,res,_next)=>{if(err?.type==='entity.parse.failed')return res.status(400).json({error:{code:'INVALID_JSON',message:'Request body must contain valid JSON.'}});if(err?.type==='entity.too.large')return res.status(413).json({error:{code:'PAYLOAD_TOO_LARGE',message:'Request body is too large.'}});if(err instanceof z.ZodError)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'Please check the submitted fields.',details:err.issues.map(i=>({path:i.path.join('.'),message:i.message}))}});if(err?.code===11000)return res.status(409).json({error:{code:'CONFLICT',message:'This record already exists.'}});if(err?.name==='CastError')return res.status(400).json({error:{code:'INVALID_ID',message:'Record ID is invalid.'}});if(Number.isInteger(err?.status)&&err?.code)return res.status(err.status).json({error:{code:err.code,message:err.message}});console.error('API error',err?.message);res.status(500).json({error:{code:'INTERNAL_ERROR',message:'Something went wrong. Please try again.'}});});
