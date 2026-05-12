import React from 'react';
import ReactDOM from 'react-dom/client';
import './team_revamp.css';

const teamMembers = [
  {
    id: 1,
    name: "Mohamed Khairy",
    role: "",
    handle: "K7airy",
    avatar: "/team/mohamed_final_transparent.png",
    status: "Online",
    bio: `AI Engineer focused on Agentic AI, autonomous workflows, and intelligent systems.
I build AI-powered products that combine LLMs, backend engineering, automation, and real-world problem solving — with a strong interest in Arabic AI experiences and education technology.
Currently working on:
- Agentic AI Systems
- AI Agents 
- Large Language Models (LLMs)
- Backend Architecture & APIs
Passionate about building products that don’t just generate answers — but reason, act, and solve problems.`,
    stats: { projects: "5+", experience: "2", gpa: "2.9+" },
  },
  {
    id: 2,
    name: "Youssef Moustafa",
    role: "",
    handle: "Youssef",
    avatar: "/team/youssef.png",
    status: "Online",
    bio: "AI Engineer focused on developing, training, and optimizing machine learning models, including large language models (LLMs), to build intelligent and data-driven applications.",
    stats: { projects: "6+", experience: "2", gpa: "3.5+" },
  },
  {
    id: 3,
    name: "Jousha Adel",
    role: "",
    handle: "Joushoa",
    avatar: "/team/jousha.png",
    status: "Online",
    bio: "AI Engineer specializing in developing and optimizing predictive models, generative AI, and advanced neural architectures to build intelligent solutions.",
    stats: { projects: "5+", experience: "2", gpa: "2.9+" },
  },
  {
    id: 4,
    name: "Mina Adly",
    role: "",
    handle: "Mina",
    avatar: "/team/mina.png",
    status: "Online",
    bio: "Backend Developer responsible for developing APIs, and ensuring seamless communication between frontend and backend systems.",
    stats: { projects: "1+", experience: "2", gpa: "2.8+" },
  },
];

/* ── Glassmorphic Profile Card ── */
const ProfileCard = ({ member }) => (
  <div className="tr-glass-card">
    {/* Ambient glow behind card */}
    <div className="tr-card-glow" />

    {/* Card inner */}
    <div className="tr-card-inner">
      {/* Top section — name & role overlay */}
      <div className="tr-card-header">
        <h3 className="tr-card-name">{member.name}</h3>
        <span className="tr-card-role">{member.role}</span>
      </div>

      {/* Avatar */}
      <div className="tr-card-avatar-area">
        <img
          src={member.avatar}
          alt={member.name}
          className="tr-card-avatar"
          loading="lazy"
        />
      </div>

      {/* Bottom info bar */}
      <div className="tr-card-footer">
        <div className="tr-card-user">
          <img src={member.avatar} alt="" className="tr-card-mini-avatar" />
          <div className="tr-card-user-text">
            <span className="tr-card-handle">@{member.handle}</span>
            <span className="tr-card-status">
              <span className="tr-status-dot" />
              {member.status}
            </span>
          </div>
        </div>
        <button className="tr-card-contact-btn" type="button">Contact</button>
      </div>
    </div>
  </div>
);

/* ── Single Member Row ── */
const MemberRow = ({ member, reversed }) => (
  <div className={`tr-member-row ${reversed ? 'tr-reversed' : ''}`}>
    {/* Info side */}
    <div className="tr-info-side">
      <h2 className="tr-member-name">
        <span className="tr-name-first">{member.name.split(' ')[0]}</span>{' '}
        <span className="tr-name-last">{member.name.split(' ').slice(1).join(' ')}</span>
      </h2>

      <p className="tr-member-bio">{member.bio}</p>

      <div className="tr-stats-row">
        <div className="tr-stat">
          <span className="tr-stat-value">
            {member.stats.projects.replace('+', '')}
            <span className="tr-accent">+</span>
          </span>
          <span className="tr-stat-label">Total Projects</span>
        </div>
        <div className="tr-stat">
          <span className="tr-stat-value">{member.stats.experience}</span>
          <span className="tr-stat-label">Years Experience</span>
        </div>
        <div className="tr-stat">
          <span className="tr-stat-value">
            {member.stats.gpa.replace('+', '')}
            <span className="tr-accent">+</span>
          </span>
          <span className="tr-stat-label">GPA</span>
        </div>
      </div>
    </div>

    {/* Card side */}
    <div className="tr-card-side">
      <ProfileCard member={member} />
    </div>
  </div>
);

/* ── Main Component ── */
const TeamRevamp = () => (
  <div className="tr-container">
    {teamMembers.map((member, i) => (
      <MemberRow key={member.id} member={member} reversed={i % 2 !== 0} />
    ))}
  </div>
);

export default TeamRevamp;
