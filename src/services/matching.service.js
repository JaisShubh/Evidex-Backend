const normalize = (value = '') => String(value).trim().toLocaleLowerCase().replace(/\s+/g, ' ');
export function getMatchingWeights(env = process.env) {
  const weights = {
    skills: Number(env.MATCH_SKILL_WEIGHT ?? 50),
    evidence: Number(env.MATCH_EVIDENCE_WEIGHT ?? 30),
    performance: Number(env.MATCH_TASK_WEIGHT ?? 20),
  };
  if (Object.values(weights).some((value) => !Number.isFinite(value) || value < 0) || Object.values(weights).reduce((sum, value) => sum + value, 0) !== 100) {
    throw new Error('MATCH_SKILL_WEIGHT, MATCH_EVIDENCE_WEIGHT, and MATCH_TASK_WEIGHT must be non-negative numbers that sum to 100.');
  }
  return weights;
}

export function calculateMatch(profile, evidence, opportunity, taskPerformance = 0, weights = getMatchingWeights()) {
  const required = [...new Set((opportunity.requiredSkills || []).map(normalize).filter(Boolean))];
  const skills = new Set((profile.skills || []).map((skill) => normalize(typeof skill === 'string' ? skill : skill.name)));
  const matchedSkills = required.filter((skill) => skills.has(skill));
  const missingSkills = required.filter((skill) => !skills.has(skill));
  const relevantEvidence = evidence.filter((item) => item.provenance !== 'sample' && !['rejected','changes_requested'].includes(item.status) && matchedSkills.some((skill) => (item.skills || []).some((evidenceSkill) => normalize(evidenceSkill) === skill) || normalize(item.title || '').includes(skill)));
  const evidenceCoverage = matchedSkills.length ? Math.min(1, relevantEvidence.length / matchedSkills.length) : 0;
  const skillOverlap = required.length ? matchedSkills.length / required.length : 0;
  const performance = Math.max(0, Math.min(1, Number(taskPerformance) || 0));
  const score = Math.round((skillOverlap * weights.skills + evidenceCoverage * weights.evidence + performance * weights.performance) * 10) / 10;
  const failures = [];
  const unverified = [];
  for (const rule of opportunity.eligibility || []) {
    if (rule.toLowerCase().startsWith('must have location:')) {
      if (normalize(profile.location) !== normalize(rule.slice(19))) failures.push(rule);
    } else {
      unverified.push(rule);
    }
  }
  const status = failures.length ? 'not_eligible' : unverified.length ? 'needs_review' : 'eligible';
  const explanation = `${matchedSkills.length}/${required.length} required skills matched (${weights.skills}% weight); ${relevantEvidence.length} skill-relevant evidence items found (${weights.evidence}%); reviewer rubric performance ${Math.round(performance * 100)}% of available points (${weights.performance}%). Weights are prototype assumptions, not validated predictions.${unverified.length ? ' Some eligibility rules need manual review.' : ''}`;
  return { score, matchedSkills, missingSkills, evidenceIds: relevantEvidence.map((item) => item._id), eligibility: { eligible: status === 'eligible', status, failures, unverified }, explanation, formulaVersion: process.env.MATCH_FORMULA_VERSION || 'v1' };
}

export function getSkillGapRecommendations(profile, opportunity, tasks = []) {
  const owned = new Set((profile.skills || []).map(skill => normalize(typeof skill === 'string' ? skill : skill.name)).filter(Boolean));
  const gaps = [...new Set((opportunity.requiredSkills || []).map(normalize).filter(skill => skill && !owned.has(skill)))];
  const recommendations = tasks
    .filter(task => task.status === 'published' && (task.visibility || 'public') === 'public')
    .map(task => ({ task, skills: [...new Set((task.requiredSkills || []).map(normalize).filter(Boolean))] }))
    .map(({ task, skills }) => ({ task, matchedGaps: gaps.filter(gap => skills.includes(gap)) }))
    .filter(({ matchedGaps }) => matchedGaps.length)
    .sort((a,b) => b.matchedGaps.length-a.matchedGaps.length || a.task.title.localeCompare(b.task.title))
    .map(({task,matchedGaps})=>({id:task._id,title:task.title,category:task.category,difficulty:task.difficulty,matchedGaps}));
  return { missingSkills: gaps, recommendations, note: 'Recommendations are practice suggestions based on task skill labels; completing a task does not automatically add or verify a skill.' };
}
