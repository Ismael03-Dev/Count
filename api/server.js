const express = require("express");
const cors = require("cors");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL,
	token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PREFIX = "count:";

async function getThreadData(threadId) {
	const raw = await redis.get(`${PREFIX}${threadId}`);
	if (!raw) return { threadId, members: [], totalMessages: 0, createdAt: Date.now() };
	if (typeof raw === "string") return JSON.parse(raw);
	return raw;
}

async function saveThreadData(threadId, data) {
	await redis.set(`${PREFIX}${threadId}`, JSON.stringify(data));
}

async function incrementMessageCount(threadId, userId, userName = "User") {
	const data = await getThreadData(threadId);
	
	let member = data.members.find(m => m.userId === userId);
	if (member) {
		member.count += 1;
		member.lastMessage = Date.now();
	} else {
		member = {
			userId,
			name: userName,
			count: 1,
			firstMessage: Date.now(),
			lastMessage: Date.now()
		};
		data.members.push(member);
	}
	
	data.totalMessages += 1;
	data.lastActivity = Date.now();
	
	await saveThreadData(threadId, data);
	return member;
}

async function getRanking(threadId, limit = 20) {
	const data = await getThreadData(threadId);
	const sorted = data.members
		.filter(m => m.count > 0)
		.sort((a, b) => b.count - a.count)
		.map((m, i) => ({
			...m,
			rank: i + 1
		}));
	
	return {
		threadId,
		totalMessages: data.totalMessages,
		totalMembers: data.members.length,
		activeMembers: sorted.length,
		top: sorted.slice(0, limit),
		full: sorted
	};
}

async function getUserRank(threadId, userId) {
	const data = await getThreadData(threadId);
	const sorted = data.members
		.filter(m => m.count > 0)
		.sort((a, b) => b.count - a.count);
	
	const user = data.members.find(m => m.userId === userId);
	if (!user) {
		return {
			userId,
			found: false,
			message: "User not found in this thread"
		};
	}
	
	const rank = sorted.findIndex(m => m.userId === userId) + 1;
	return {
		userId: user.userId,
		name: user.name,
		count: user.count,
		rank: rank || sorted.length + 1,
		totalMembers: sorted.length,
		totalMessages: data.totalMessages,
		firstMessage: user.firstMessage,
		lastMessage: user.lastMessage,
		found: true
	};
}

async function resetThread(threadId) {
	await redis.del(`${PREFIX}${threadId}`);
	return { threadId, reset: true };
}

async function resetUser(threadId, userId) {
	const data = await getThreadData(threadId);
	data.members = data.members.filter(m => m.userId !== userId);
	await saveThreadData(threadId, data);
	return { threadId, userId, reset: true };
}

async function getThreadStats(threadId) {
	const data = await getThreadData(threadId);
	const sorted = data.members
		.filter(m => m.count > 0)
		.sort((a, b) => b.count - a.count);
	
	const avgMessages = data.members.length > 0 
		? Math.round(data.totalMessages / data.members.length) 
		: 0;
	
	return {
		threadId,
		totalMessages: data.totalMessages,
		totalMembers: data.members.length,
		activeMembers: sorted.length,
		avgMessagesPerMember: avgMessages,
		mostActive: sorted.length > 0 ? sorted[0] : null,
		leastActive: sorted.length > 0 ? sorted[sorted.length - 1] : null,
		createdAt: data.createdAt,
		lastActivity: data.lastActivity
	};
}

async function getAllThreads() {
	const keys = await redis.keys(`${PREFIX}*`);
	const threads = [];
	for (const key of keys) {
		const threadId = key.replace(PREFIX, "");
		const data = await getThreadData(threadId);
		threads.push({
			threadId,
			members: data.members.length,
			totalMessages: data.totalMessages,
			lastActivity: data.lastActivity
		});
	}
	return threads;
}

app.get("/", (req, res) => {
	res.json({
		message: "Count API opérationnelle",
		version: "1.0",
		endpoints: {
			"GET /api/count/:threadId": "Get thread data",
			"POST /api/count/:threadId/message": "Increment message count",
			"GET /api/count/:threadId/ranking": "Get ranking",
			"GET /api/count/:threadId/ranking/:userId": "Get user rank",
			"GET /api/count/:threadId/stats": "Get thread stats",
			"DELETE /api/count/:threadId": "Reset thread",
			"DELETE /api/count/:threadId/user/:userId": "Reset user",
			"GET /api/count/threads": "Get all threads"
		}
	});
});

app.get("/api/count/:threadId", async (req, res) => {
	const { threadId } = req.params;
	try {
		const data = await getThreadData(threadId);
		res.json({ success: true, data });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.post("/api/count/:threadId/message", async (req, res) => {
	const { threadId } = req.params;
	const { userId, userName } = req.body;
	
	if (!userId) {
		return res.status(400).json({ 
			success: false, 
			error: "userId is required" 
		});
	}
	
	try {
		const member = await incrementMessageCount(threadId, userId, userName);
		res.json({
			success: true,
			data: {
				userId: member.userId,
				name: member.name,
				count: member.count,
				firstMessage: member.firstMessage,
				lastMessage: member.lastMessage
			}
		});
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/api/count/:threadId/ranking", async (req, res) => {
	const { threadId } = req.params;
	const limit = parseInt(req.query.limit) || 20;
	
	try {
		const ranking = await getRanking(threadId, limit);
		res.json({ success: true, data: ranking });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/api/count/:threadId/ranking/:userId", async (req, res) => {
	const { threadId, userId } = req.params;
	
	try {
		const result = await getUserRank(threadId, userId);
		res.json({ success: true, data: result });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/api/count/:threadId/stats", async (req, res) => {
	const { threadId } = req.params;
	
	try {
		const stats = await getThreadStats(threadId);
		res.json({ success: true, data: stats });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.delete("/api/count/:threadId", async (req, res) => {
	const { threadId } = req.params;
	const { confirm } = req.body;
	
	if (confirm !== "yes") {
		return res.status(400).json({
			success: false,
			error: "Confirmation required: { confirm: 'yes' }"
		});
	}
	
	try {
		const result = await resetThread(threadId);
		res.json({ success: true, data: result });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.delete("/api/count/:threadId/user/:userId", async (req, res) => {
	const { threadId, userId } = req.params;
	
	try {
		const result = await resetUser(threadId, userId);
		res.json({ success: true, data: result });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/api/count/threads", async (req, res) => {
	try {
		const threads = await getAllThreads();
		res.json({ success: true, data: threads });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

module.exports = app;