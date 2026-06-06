function debug(...args) {
    if (process.env.DEBUG) console.log('[DEBUG]', ...args);
}

async function reply(context, content) {
    if (context.deferred || context.replied) {
        return context.followUp(content);
    } else if (context.reply) {
        return context.reply(content);
    } else {
        return context.channel.send(content);
    }
}

module.exports = { reply, debug };
