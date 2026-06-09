const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { reply } = require('../utils');

function toUnix(field) {
    if (!field) return null;
    const ts = field.endsWith('Z') ? field : field.replace(' ', 'T') + 'Z';
    return Math.floor(new Date(ts).getTime() / 1000);
}

function formatUserId(id) {
    if (/^\d+$/.test(id)) return `<@${id}>`;
    return `[${id}](https://namemc.com/profile/${id})`;
}

function init(hub) {
    async function createTrade(context, withUser, description) {
        const author = context.user || context.author;
        const guild = context.guild;
        const channel = context.channel;

        if (withUser.id === author.id) {
            return reply(context, '❌ You cannot trade with yourself!');
        }
        if (withUser.bot) {
            return reply(context, '❌ You cannot trade with bots!');
        }

        const [{ scammer: initiatorScammer }, { scammer: recipientScammer }] = await Promise.all([
            hub.api('GET', `/tradebot/user/${author.id}/scammer`),
            hub.api('GET', `/tradebot/user/${withUser.id}/scammer`)
        ]);

        if (initiatorScammer) {
            return reply(context, '❌ You are marked as a scammer and cannot initiate trades!');
        }
        if (recipientScammer) {
            const warningEmbed = new EmbedBuilder()
                .setTitle('⚠️ SCAMMER WARNING')
                .setDescription(`**${withUser.displayName || withUser.username}** is marked as a scammer!`)
                .addFields(
                    { name: 'Reason', value: recipientScammer.reason, inline: true },
                    { name: 'Marked By', value: `<@${recipientScammer.moderator_id}>`, inline: true }
                )
                .setColor('#ff0000')
                .setFooter({ text: 'Proceed with extreme caution!' });
            return reply(context, { embeds: [warningEmbed] });
        }

        const { id: tradeId } = await hub.api('POST', '/tradebot/trade', {
            initiator_id: author.id,
            recipient_id: withUser.id,
            description,
            guild_id: guild.id,
            channel_id: channel.id
        });
        console.log(`[Database] Trade #${tradeId} created by ${author.tag} for ${withUser.tag}`);

        const embed = new EmbedBuilder()
            .setTitle('📋 New Trade Proposal')
            .setDescription(`**Trade ID:** ${tradeId}`)
            .addFields(
                { name: '👥 Participants', value: `**Initiator:** <@${author.id}> ✅\n**Recipient:** <@${withUser.id}> ⏳`, inline: false },
                { name: '📝 Description', value: description, inline: false },
                { name: '⏰ Status', value: '⏳ Waiting for recipient to confirm the trade', inline: false }
            )
            .setFooter({ text: 'Recipient must confirm to finalize the trade' })
            .setColor('#0099ff');

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_${tradeId}_${author.id}_${withUser.id}`)
                    .setLabel('✅ Confirm')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`reject_${tradeId}_${author.id}_${withUser.id}`)
                    .setLabel('❌ Reject')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`report_${tradeId}`)
                    .setLabel('🚨 Report')
                    .setStyle(ButtonStyle.Secondary)
            );

        await reply(context, { content: `<@${author.id}> <@${withUser.id}>`, embeds: [embed], components: [row] });
    }

    async function handleConfirm(interaction, tradeId) {
        let result;
        try {
            result = await hub.api('POST', `/tradebot/trade/${tradeId}/confirm`);
        } catch (err) {
            if (err.status === 404) {
                return interaction.reply({ content: '❌ Trade not found.', flags: 64 });
            }
            if (err.status === 409) {
                return interaction.reply({ content: `❌ ${err.message}`, flags: 64 });
            }
            throw err;
        }

        const t = result.trade;
        const embed = new EmbedBuilder()
            .setTitle('✅ Trade Confirmed!')
            .setDescription('This trade has been confirmed and finalized!')
            .addFields({
                name: 'Trade Details',
                value: `**Between:** <@${t.initiator_id}> ↔️ <@${t.recipient_id}>\n**Description:** ${t.description}\n**Confirmed:** <t:${Math.floor(Date.now() / 1000)}:R>`,
                inline: false
            })
            .setColor('#00ff00');

        const disabledRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('disabled_confirm')
                    .setLabel('✅ Confirmed')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('disabled_reject')
                    .setLabel('❌ Reject')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );

        await interaction.update({ embeds: [embed], components: [disabledRow] });
    }

    async function handleReject(interaction, tradeId) {
        try {
            await hub.api('POST', `/tradebot/trade/${tradeId}/reject`);
        } catch (err) {
            if (err.status === 404) {
                return interaction.reply({ content: '❌ Trade not found.', flags: 64 });
            }
            if (err.status === 409) {
                return interaction.reply({ content: '❌ This trade is no longer pending and cannot be rejected.', flags: 64 });
            }
            throw err;
        }

        const embed = new EmbedBuilder()
            .setTitle('❌ Trade Rejected')
            .setDescription('This trade has been rejected.')
            .setColor('#ff0000');

        const disabledRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('disabled_confirm')
                    .setLabel('✅ Confirm')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('disabled_reject')
                    .setLabel('❌ Reject')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );

        await interaction.update({ embeds: [embed], components: [disabledRow] });
    }

    async function handleButtonInteraction(interaction) {
        const [action, tradeId, initiatorId, recipientId] = interaction.customId.split('_');
        console.log(`[Button] ${interaction.user.tag} clicked: ${action} on Trade #${tradeId}`);
        const userId = interaction.user.id;

        if (action === 'confirm') {
            if (userId !== recipientId) {
                return interaction.reply({ content: 'Only the recipient can confirm this trade.', flags: 64 });
            }
            await handleConfirm(interaction, tradeId);
        } else if (action === 'reject') {
            if (userId !== initiatorId && userId !== recipientId) {
                return interaction.reply({ content: 'You cannot interact with this trade.', flags: 64 });
            }
            await handleReject(interaction, tradeId);
        }
    }

    async function showTrades(context, user) {
        const trades = await hub.api('GET', `/tradebot/user/${user.id}/trades`);

        if (!trades.length) {
            const embed = new EmbedBuilder()
                .setTitle(`📊 Trade History for ${user.displayName || user.username}`)
                .setDescription('No trades found.')
                .setColor('#0099ff');
            return reply(context, { embeds: [embed] });
        }

        const embed = new EmbedBuilder()
            .setTitle(`📊 Trade History for ${user.displayName || user.username}`)
            .setDescription(`Showing last ${trades.length} trades`)
            .setColor('#0099ff');

        for (const trade of trades) {
            const otherUserId = trade.initiator_id === user.id ? trade.recipient_id : trade.initiator_id;
            const statusEmoji = { confirmed: '✅', rejected: '❌', cancelled: '⛔' }[trade.status] || '❓';
            const role = trade.initiator_id === user.id ? 'Initiator' : 'Recipient';
            const createdTimestamp = toUnix(trade.created_at);
            const confirmedInfo = trade.confirmed_at ? `\n**Confirmed:** <t:${toUnix(trade.confirmed_at)}:R>` : '';

            embed.addFields({
                name: `${statusEmoji} Trade #${trade.id} - ${trade.status.charAt(0).toUpperCase() + trade.status.slice(1)}`,
                value: `**${role}** with ${formatUserId(otherUserId)}\n**Description:** ${trade.description}\n**Created:** <t:${createdTimestamp}:R>${confirmedInfo}`,
                inline: false
            });
        }

        await reply(context, { embeds: [embed] });
    }

    async function showTradeStats(context, user) {
        const { stats, partners, warnings, scammerStatus } = await hub.api('GET', `/tradebot/user/${user.id}/trade-stats`);

        let embedColor = '#00ff00';
        if (scammerStatus) embedColor = '#ff0000';
        else if (warnings.length > 0) embedColor = '#ff9900';

        const embed = new EmbedBuilder()
            .setTitle(`📈 Trading Statistics for ${user.displayName || user.username}`)
            .setColor(embedColor);

        embed.addFields(
            {
                name: '📊 Trade Summary',
                value: `**Total Trades:** ${stats.total_trades}\n**✅ Confirmed:** ${stats.confirmed_trades}\n**❌ Rejected:** ${stats.rejected_trades}`,
                inline: true
            },
            {
                name: '🎯 Activity',
                value: `**Initiated:** ${stats.initiated_trades}\n**Received:** ${stats.total_trades - stats.initiated_trades}`,
                inline: true
            }
        );

        if (stats.confirmed_trades > 0) {
            const successRate = ((stats.confirmed_trades / stats.total_trades) * 100).toFixed(1);
            embed.addFields({ name: '📈 Success Rate', value: `${successRate}%`, inline: true });
        }

        if (partners.length > 0) {
            embed.addFields({
                name: '👥 Top Trading Partners',
                value: partners.map(p => `${formatUserId(p.partner_id)}: ${p.trade_count} trades`).join('\n'),
                inline: false
            });
        }

        if (scammerStatus) {
            embed.addFields({
                name: '🚨 SCAMMER WARNING',
                value: `**Reason:** ${scammerStatus.reason}\n**Marked:** <t:${toUnix(scammerStatus.created_at)}:R>\n**By:** <@${scammerStatus.moderator_id}>`,
                inline: false
            });
        }

        if (warnings.length > 0) {
            const warningsList = warnings.slice(0, 3).map(w => `**${w.reason}** - <t:${toUnix(w.created_at)}:R>`);
            embed.addFields({
                name: `⚠️ Recent Warnings (${warnings.length} total)`,
                value: warningsList.join('\n'),
                inline: false
            });
            if (warnings.length > 3) {
                embed.setFooter({ text: `Showing 3 of ${warnings.length} warnings. Use /warnings for full list.` });
            }
        } else if (!scammerStatus) {
            embed.addFields({ name: '✅ User Status', value: 'No warnings or flags on record', inline: false });
        }

        await reply(context, { embeds: [embed] });
    }

    async function showTradesByMcUser(context, mcUsername) {
        let uuid;
        try {
            const data = await hub.api('GET', `/convert-username-to-uuid?username=${encodeURIComponent(mcUsername)}`);
            uuid = data?.uuid;
        } catch {
            return reply(context, `❌ Minecraft user \`${mcUsername}\` not found.`);
        }
        if (!uuid) return reply(context, `❌ Minecraft user \`${mcUsername}\` not found.`);
        await showTrades(context, { id: uuid, displayName: mcUsername, username: mcUsername });
    }

    async function showStatsByMcUser(context, mcUsername) {
        let uuid;
        try {
            const data = await hub.api('GET', `/convert-username-to-uuid?username=${encodeURIComponent(mcUsername)}`);
            uuid = data?.uuid;
        } catch {
            return reply(context, `❌ Minecraft user \`${mcUsername}\` not found.`);
        }
        if (!uuid) return reply(context, `❌ Minecraft user \`${mcUsername}\` not found.`);
        await showTradeStats(context, { id: uuid, displayName: mcUsername, username: mcUsername });
    }

    function listenForMcConfirms(discordClient) {
        const MC_CHANNEL_ID = 'minecraft';
        hub.onMessage(async (payload) => {
            if (payload.action !== 'trade_confirmed') return;
            const trade = payload.data?.trade;
            if (!trade || trade.channel_id !== MC_CHANNEL_ID) return;

            let initiatorName = trade.initiator_id;
            let recipientName = trade.recipient_id;
            try { initiatorName = (await hub.api('GET', `/tradebot/mc-username/${trade.initiator_id}`)).username ?? initiatorName; } catch {}
            try { recipientName = (await hub.api('GET', `/tradebot/mc-username/${trade.recipient_id}`)).username ?? recipientName; } catch {}

            const initiatorLink = `[${initiatorName}](https://namemc.com/profile/${trade.initiator_id})`;
            const recipientLink = `[${recipientName}](https://namemc.com/profile/${trade.recipient_id})`;

            const embed = new EmbedBuilder()
                .setTitle('✅ Trade Confirmed! (Minecraft)')
                .setDescription(`A trade on \`${trade.guild_id}\` has been confirmed.`)
                .addFields({
                    name: 'Trade Details',
                    value: `**Between:** ${initiatorLink} ↔️ ${recipientLink}\n**Description:** ${trade.description}\n**Confirmed:** <t:${Math.floor(Date.now() / 1000)}:R>`,
                    inline: false
                })
                .setColor('#00ff00');

            for (const guild of discordClient.guilds.cache.values()) {
                const channel = guild.channels.cache.find(ch => ch.name.includes('verified-trade') && ch.type === 0);
                if (channel) {
                    try { await channel.send({ embeds: [embed] }); } catch {}
                }
            }
        });
    }

    return { createTrade, handleButtonInteraction, showTrades, showTradeStats, showTradesByMcUser, showStatsByMcUser, listenForMcConfirms };
}

module.exports = init;
