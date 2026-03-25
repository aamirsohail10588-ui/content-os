// ============================================================
// MODULE: mockAiProvider.js
// PURPOSE: Mock AI responses for Phase 1
// ============================================================

const { createLogger } = require('./logger');
const log = createLogger('MockAiProvider');

const MOCK_HOOKS = {
  curiosity_gap: [
    "There's a reason 90% of people never build wealth — and it has nothing to do with income.",
    "The wealthiest people I know all do this one thing before 8 AM.",
    "Banks don't want you to know this about your savings account.",
    "I stopped saving money 3 years ago. My net worth tripled.",
    "The biggest financial lie you were taught as a kid.",
  ],
  shocking_stat: [
    "The average American pays $150,000 in unnecessary fees over their lifetime.",
    "78% of workers live paycheck to paycheck — even those making six figures.",
    "Inflation has silently stolen 25% of your savings in the last 4 years.",
    "Only 12% of mutual funds beat the market. Yet 88% of people still use them.",
    "The top 1% pay a lower tax rate than you. Here's the math.",
  ],
  direct_question: [
    "Do you actually know how compound interest works — or do you just think you do?",
    "What would you do differently if you knew you'd be broke at 65?",
    "How much of your income is actually yours after taxes, rent, and debt?",
    "Are you investing — or are you gambling and calling it investing?",
    "What if everything you were taught about money was designed to keep you poor?",
  ],
  bold_claim: [
    "You don't need a budget. You need a system.",
    "The stock market is the greatest wealth transfer machine ever built — if you know the rules.",
    "Debt is not the enemy. Financial ignorance is.",
    "Your 401k is a trap designed in the 1970s for a world that no longer exists.",
    "In 10 years, people who don't understand AI and money will be unemployable.",
  ],
  contrarian: [
    "Saving money is the slowest way to build wealth.",
    "Dave Ramsey's advice will keep you middle class forever.",
    "Paying off your mortgage early is a terrible financial decision.",
    "Emergency funds are overrated. Here's what smart money does instead.",
    "Frugality is a losing strategy in an inflationary economy.",
  ],
  story_open: [
    "I was $47,000 in debt at 23. Here's exactly how I got to $500K by 30.",
    "My grandfather built a fortune with one simple rule he learned during the Depression.",
    "A hedge fund manager told me something at a dinner party that changed everything.",
    "Last year I made a single investment that returned more than my entire salary.",
    "I watched my parents go bankrupt. It taught me the one rule of money nobody talks about.",
  ],
  pattern_interrupt: [
    "Stop. Before you make another trade, watch this.",
    "DELETE your budget app. Right now. I'm serious.",
    "If your financial advisor told you this, fire them immediately.",
    "Pause this video if you have more than $10K in a savings account.",
    "I'm going to say something that every bank in America hates.",
  ],
};

const MOCK_SCRIPT_BODIES = [
  "Most people think building wealth is about earning more. It's not. It's about understanding where your money actually goes — and redirecting it. The average person loses 30% of their potential wealth to fees, bad timing, and emotional decisions. The fix isn't complicated. First, automate your investments so emotions never enter the equation. Second, understand the difference between assets and liabilities — most people have this backwards. Third, focus on increasing your income by 10% every year, not cutting your latte budget. The math is simple. The discipline is the hard part. But here's the truth — if you start today, even with $100, compound interest turns time into your most powerful asset.",

  "Here's what Wall Street doesn't teach you. The market isn't designed for you to win — it's designed for institutions to profit from your behavior. Every time you panic sell, someone buys your shares at a discount. Every time you chase a hot stock, market makers are already positioned. The solution? Stop playing their game. Index funds, dollar cost averaging, and a 10-year time horizon. That's it. It's boring. It's unsexy. And it outperforms 90% of professional fund managers. The data proves it. Your emotions will fight it. But the math doesn't lie.",

  "Let's talk about the wealth gap — not politically, but mathematically. The top 10% own assets. The bottom 90% own liabilities they think are assets. Your car loses value. Your house costs you maintenance, taxes, and interest. Your degree cost you $80K but your skills determine your income. Real assets generate cash flow while you sleep — dividend stocks, rental properties, digital businesses, intellectual property. The shift from consumer to owner is the single most important financial decision you'll ever make. And it starts with one question: does this thing I'm buying make me money, or cost me money?",
];

function getMockHooks(pattern, count) {
  const hooks = MOCK_HOOKS[pattern] || MOCK_HOOKS['curiosity_gap'];
  const shuffled = [...hooks].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function getMockScriptBody() {
  return MOCK_SCRIPT_BODIES[Math.floor(Math.random() * MOCK_SCRIPT_BODIES.length)];
}

async function mockAiCall(request) {
  // No delay in mock mode for fast testing
  log.info('Mock AI call completed', { promptLength: request.prompt?.length || 0 });
  return {
    content: request.prompt,
    tokensUsed: Math.floor(Math.random() * 200) + 100,
    model: 'mock-claude-sonnet',
    latencyMs: 100,
  };
}

module.exports = { getMockHooks, getMockScriptBody, mockAiCall };
