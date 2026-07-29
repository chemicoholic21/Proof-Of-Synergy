/**
 * Extract concrete technologies mentioned in an interview conversation (React, FastAPI, Postgres,
 * …) so the Skill Knowledge Graph shows the actual skills discussed — not the scenario label.
 *
 * A curated alias dictionary keeps this deterministic and fast (no extra model call). Matching is
 * whole-token and case-insensitive with alphanumeric boundaries, so "java" does not match inside
 * "javascript", yet a tech followed by punctuation ("Kubernetes.") still matches. Special chars
 * (c++, c#, .net, next.js) live inside the alias literals, so the boundary itself stays simple.
 */

export interface TechSkill {
  name: string;
  category: string;
}

interface TechDef {
  canonical: string;
  category: string;
  aliases: string[];
}

// Categories become grouping nodes in the graph, so keep them human-readable.
const TECHS: TechDef[] = [
  // Languages
  { canonical: "JavaScript", category: "Languages", aliases: ["javascript"] },
  { canonical: "TypeScript", category: "Languages", aliases: ["typescript"] },
  { canonical: "Python", category: "Languages", aliases: ["python"] },
  { canonical: "Java", category: "Languages", aliases: ["java"] },
  { canonical: "Go", category: "Languages", aliases: ["golang", "go lang"] },
  { canonical: "Rust", category: "Languages", aliases: ["rust"] },
  { canonical: "C++", category: "Languages", aliases: ["c++", "cpp"] },
  { canonical: "C#", category: "Languages", aliases: ["c#", "csharp", "c sharp"] },
  { canonical: "Kotlin", category: "Languages", aliases: ["kotlin"] },
  { canonical: "Swift", category: "Languages", aliases: ["swift"] },
  { canonical: "Ruby", category: "Languages", aliases: ["ruby"] },
  { canonical: "PHP", category: "Languages", aliases: ["php"] },
  { canonical: "Scala", category: "Languages", aliases: ["scala"] },
  { canonical: "SQL", category: "Languages", aliases: ["sql"] },

  // Frontend / frameworks
  { canonical: "React", category: "Frameworks", aliases: ["react", "reactjs", "react.js"] },
  { canonical: "Next.js", category: "Frameworks", aliases: ["next.js", "nextjs", "next js"] },
  { canonical: "Angular", category: "Frameworks", aliases: ["angular"] },
  { canonical: "Vue", category: "Frameworks", aliases: ["vue", "vuejs", "vue.js"] },
  { canonical: "Svelte", category: "Frameworks", aliases: ["svelte", "sveltekit"] },
  { canonical: "Redux", category: "Frameworks", aliases: ["redux"] },
  { canonical: "Tailwind CSS", category: "Frameworks", aliases: ["tailwind", "tailwindcss", "tailwind css"] },
  { canonical: "Node.js", category: "Frameworks", aliases: ["node.js", "nodejs", "node js", "node"] },
  { canonical: "Express", category: "Frameworks", aliases: ["express", "expressjs", "express.js"] },
  { canonical: "NestJS", category: "Frameworks", aliases: ["nestjs", "nest.js"] },
  { canonical: "Django", category: "Frameworks", aliases: ["django"] },
  { canonical: "Flask", category: "Frameworks", aliases: ["flask"] },
  { canonical: "FastAPI", category: "Frameworks", aliases: ["fastapi", "fast api"] },
  { canonical: "Spring", category: "Frameworks", aliases: ["spring", "spring boot", "springboot"] },
  { canonical: "Ruby on Rails", category: "Frameworks", aliases: ["ruby on rails", "rails"] },
  { canonical: "Laravel", category: "Frameworks", aliases: ["laravel"] },
  { canonical: ".NET", category: "Frameworks", aliases: [".net", "dotnet", "asp.net"] },
  { canonical: "GraphQL", category: "Frameworks", aliases: ["graphql"] },
  { canonical: "gRPC", category: "Frameworks", aliases: ["grpc"] },

  // Databases / data infra
  { canonical: "PostgreSQL", category: "Databases", aliases: ["postgresql", "postgres", "psql"] },
  { canonical: "MySQL", category: "Databases", aliases: ["mysql"] },
  { canonical: "MongoDB", category: "Databases", aliases: ["mongodb", "mongo"] },
  { canonical: "Redis", category: "Databases", aliases: ["redis"] },
  { canonical: "SQLite", category: "Databases", aliases: ["sqlite"] },
  { canonical: "Elasticsearch", category: "Databases", aliases: ["elasticsearch", "elastic search"] },
  { canonical: "Cassandra", category: "Databases", aliases: ["cassandra"] },
  { canonical: "DynamoDB", category: "Databases", aliases: ["dynamodb", "dynamo db"] },
  { canonical: "Firebase", category: "Databases", aliases: ["firebase", "firestore"] },
  { canonical: "Kafka", category: "Databases", aliases: ["kafka"] },
  { canonical: "RabbitMQ", category: "Databases", aliases: ["rabbitmq"] },

  // Cloud & DevOps
  { canonical: "AWS", category: "Cloud & DevOps", aliases: ["aws", "amazon web services"] },
  { canonical: "GCP", category: "Cloud & DevOps", aliases: ["gcp", "google cloud"] },
  { canonical: "Azure", category: "Cloud & DevOps", aliases: ["azure"] },
  { canonical: "Docker", category: "Cloud & DevOps", aliases: ["docker"] },
  { canonical: "Kubernetes", category: "Cloud & DevOps", aliases: ["kubernetes", "k8s"] },
  { canonical: "Terraform", category: "Cloud & DevOps", aliases: ["terraform"] },
  { canonical: "Jenkins", category: "Cloud & DevOps", aliases: ["jenkins"] },
  { canonical: "CI/CD", category: "Cloud & DevOps", aliases: ["ci/cd", "cicd"] },
  { canonical: "Nginx", category: "Cloud & DevOps", aliases: ["nginx"] },
  { canonical: "Kafka Streams", category: "Cloud & DevOps", aliases: ["kafka streams"] },

  // Data & ML
  { canonical: "TensorFlow", category: "Data & ML", aliases: ["tensorflow"] },
  { canonical: "PyTorch", category: "Data & ML", aliases: ["pytorch"] },
  { canonical: "scikit-learn", category: "Data & ML", aliases: ["scikit-learn", "sklearn", "scikit learn"] },
  { canonical: "Pandas", category: "Data & ML", aliases: ["pandas"] },
  { canonical: "NumPy", category: "Data & ML", aliases: ["numpy"] },
  { canonical: "Spark", category: "Data & ML", aliases: ["apache spark", "spark"] },
  { canonical: "Airflow", category: "Data & ML", aliases: ["airflow"] },
  { canonical: "LangChain", category: "Data & ML", aliases: ["langchain"] },
  { canonical: "LLMs", category: "Data & ML", aliases: ["llm", "llms", "large language model"] },

  // Concepts
  { canonical: "REST APIs", category: "Concepts", aliases: ["rest api", "restful", "rest apis"] },
  { canonical: "Microservices", category: "Concepts", aliases: ["microservices", "microservice"] },
  { canonical: "WebSockets", category: "Concepts", aliases: ["websocket", "websockets"] },
  { canonical: "System Design", category: "Concepts", aliases: ["system design"] },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the technologies mentioned in `text`, in first-appearance order, de-duplicated and
 * capped at `limit`.
 */
export function extractTechSkills(text: string, limit = 14): TechSkill[] {
  const lower = (text || "").toLowerCase();
  if (!lower.trim()) return [];

  const hits: { def: TechDef; index: number }[] = [];
  for (const def of TECHS) {
    let firstIndex = -1;
    for (const alias of def.aliases) {
      // Whole-token match with alphanumeric boundaries (specials are inside the alias literal).
      const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`);
      const m = re.exec(lower);
      if (m) firstIndex = firstIndex < 0 ? m.index : Math.min(firstIndex, m.index);
    }
    if (firstIndex >= 0) hits.push({ def, index: firstIndex });
  }

  hits.sort((a, b) => a.index - b.index);
  const out: TechSkill[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.def.canonical)) continue;
    seen.add(h.def.canonical);
    out.push({ name: h.def.canonical, category: h.def.category });
    if (out.length >= limit) break;
  }
  return out;
}
