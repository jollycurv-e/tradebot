async function reply(context, content) {
    if (context.deferred || context.replied) {
        return context.followUp(content);
    } else if (context.reply) {
        return context.reply(content);
    } else {
        return context.channel.send(content);
    }
}

module.exports = { reply };
