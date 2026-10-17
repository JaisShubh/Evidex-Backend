const normalize = (value = '') => String(value).trim().toLocaleLowerCase().replace(/\s+/g, ' ');
export function calculateMatch(profile, evidence, opportunity, taskPerformance = 0) {
  const required = [...new Set((opportunity.requiredSkills || []).map(normalize).filter(Boolean))];
  const skills = new Set((profile.skills || []).map((skill) => normalize(typeof skill === 'string' ? skill : skill.name)));
  const matchedSkills = required.filter((skill) => skills.has(skill));
  const missingSkills = required.filter((skill) => !skills.has(skill));
  const relevantEvidence = evidence.filter((item) => matchedSkills.some((skill) => normalize(item.title || '').includes(skill)));
  const evidenceCoverage = matchedSkills.length ? Math.min(1, relevantEvidence.length / matchedSkills.length) : 0;
  const skillOverlap = required.length ? matchedSkills.length / required.length : 0;
  const score = Math.round((skillOverlap * 50 + evidenceCoverage * 30 + taskPerformance * 20) * 10) / 10;
  const failures = (opportunity.eligibility || []).filter((rule) => rule.toLowerCase().startsWith('must have location:') && normalize(profile.location) !== normalize(rule.slice(19)));
  return { score, matchedSkills, missingSkills, evidenceIds: relevantEvidence.map((item) => item._id), eligibility: { eligible: failures.length === 0, failures }, explanation: `${matchedSkills.length}/${required.length} required skills matched (50% weight); ${relevantEvidence.length} skill-relevant evidence items found (30%); reviewer rubric performance ${Math.round(taskPerformance * 100)}% of available points (20%). Weights are prototype assumptions, not validated predictions.` };
}
