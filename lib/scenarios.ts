import { Scenario } from "@/lib/types";

export const SCENARIOS: Scenario[] = [
  {
    id: "technical-deep-dive",
    title: "Technical Deep Dive",
    description: "Practice explaining deep technical topics with clarity and structure. Great for system design, coding, or architecture discussions.",
    difficulty: "intermediate",
    tags: ["technical", "structured"],
    systemPrompt: "You are a senior engineer in a practice session. Ask one technical question at a time. Follow up on interesting details. Be encouraging but probing.",
    openingMessage: "Let's start with a technical question. Tell me about a complex system you built recently. What was the hardest part, and how did you solve it?",
  },
  {
    id: "startup-pitch",
    title: "Startup Pitch",
    description: "Practice delivering a compelling pitch. Work on hooking attention, explaining value, and handling tough questions from investors.",
    difficulty: "advanced",
    tags: ["persuasion", "storytelling"],
    systemPrompt: "You are a skeptical but curious investor. The learner is pitching you a startup. Ask sharp follow-up questions about market, traction, and differentiation. Push back gently on weak points.",
    openingMessage: "I've got 30 seconds before my next meeting. Pitch me your startup.",
  },
  {
    id: "design-review",
    title: "Engineering Design Review",
    description: "Walk through a system design while a senior engineer challenges your assumptions. Practice trade-off explanations and defending decisions.",
    difficulty: "advanced",
    tags: ["technical", "structured", "leadership"],
    systemPrompt: "You are a staff engineer reviewing a design doc. Ask clarifying questions, probe edge cases, and challenge assumptions. Be constructive but rigorous.",
    openingMessage: "Walk me through the design you're proposing. What are the key trade-offs?",
  },
  {
    id: "product-demo",
    title: "Product Demo",
    description: "Practice demonstrating a product to a stakeholder. Focus on value storytelling, handling objections, and keeping it concise.",
    difficulty: "intermediate",
    tags: ["storytelling", "persuasion"],
    systemPrompt: "You are a product manager evaluating a demo. Ask about user impact, metrics, and roadmap. Show genuine interest but push for specifics.",
    openingMessage: "Show me what you've built. Walk me through the user experience and why it matters.",
  },
  {
    id: "public-speaking",
    title: "Public Speaking",
    description: "Practice delivering a talk or presentation. Get coaching on pacing, filler words, structure, and audience engagement.",
    difficulty: "intermediate",
    tags: ["storytelling", "clarity"],
    systemPrompt: "You are an audience member at a conference talk. React naturally, ask questions at the end, and provide gentle feedback if the speaker loses you.",
    openingMessage: "The room is settling. Go ahead and start your talk when you're ready.",
  },
  {
    id: "leadership",
    title: "Leadership Conversation",
    description: "Practice difficult conversations: giving feedback, resolving conflict, or aligning a team. Focus on empathy and clarity.",
    difficulty: "advanced",
    tags: ["leadership", "clarity", "empathy"],
    systemPrompt: "You are a direct report who just had a rough week. The learner needs to check in and give feedback. Be honest, slightly defensive at first, but responsive to empathy.",
    openingMessage: "Thanks for making time. I wanted to check in after yesterday's launch.",
  },
  {
    id: "viva",
    title: "College Viva / Thesis Defense",
    description: "Practice defending your research or thesis. Get grilled on methodology, related work, and limitations.",
    difficulty: "intermediate",
    tags: ["technical", "structured"],
    systemPrompt: "You are a thesis examiner. Ask methodological questions, probe limitations, and test depth of understanding. Be rigorous but fair.",
    openingMessage: "Let's start with your research question. Why does this problem matter?",
  },
];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
