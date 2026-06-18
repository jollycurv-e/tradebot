const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { debug } = require('../utils.js');

function toUnix(field) {
    if (!field) return null;
    if (typeof field === 'number') return Math.floor(field / 1000);
    const ts = String(field).endsWith('Z') ? field : field.replace(' ', 'T') + 'Z';
    return Math.floor(new Date(ts).getTime() / 1000);
}

function init(hub) {
    async function checkModeratorPermission(interaction) {
        if (!interaction.member.permissions.has('ManageMessages') && !interaction.member.permissions.has('Administrator')) {
            await interaction.reply({
                content: '❌ You need "Manage Messages" or "Administrator" permissions to use moderation commands.',
                flags: 64
            });
            return false;
        }
        return true;
    }

    async function showModeratedTrades(interaction, status) {
        await interaction.deferReply();
        const reports = await hub.api('GET', `/tradebot/reports?status=${status}`);

        if (!reports.length) {
            const embed = new EmbedBuilder()
                .setTitle('🛡️ Trade Reports')
                .setDescription(`No ${status === 'all' ? '' : status} reports found.`)
                .setColor('#0099ff');
            return interaction.editReply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
            .setTitle('🛡️ Trade Reports')
            .setDescription(`Showing ${reports.length} ${status === 'all' ? '' : status} reports`)
            .setColor('#ff9900');

        const allIds = reports.flatMap(r => [r.reporter_id, r.reported_user_id]);
        const mcIds = [...new Set(allIds.filter(isMcUuid))];
        await Promise.all(mcIds.map(async id => {
            if (!usernameCache.has(id)) {
                const data = await hub.api('GET', `/tradebot/mc-username/${id}`).catch(() => null);
                if (data?.username) usernameCache.set(id, data.username);
            }
        }));

        function formatReportUser(id) {
            if (isMcUuid(id)) {
                const name = usernameCache.get(id) || id;
                return `[${name}](https://namemc.com/profile/${id})`;
            }
            return `<@${id}>`;
        }

        for (const report of reports) {
            const statusEmoji = report.status === 'pending' ? '⏳' : '✅';
            const createdTimestamp = toUnix(report.created_at);
            const tradeLabel = !report.trade_id ? 'User Report' : `Trade #${report.trade_id}`;

            embed.addFields({
                name: `${statusEmoji} Report #${report.id} - ${tradeLabel}`,
                value: `**Reporter:** ${formatReportUser(report.reporter_id)}\n**Reported:** ${formatReportUser(report.reported_user_id)}\n**Reason:** ${report.reason}\n**Created:** <t:${createdTimestamp}:R>`,
                inline: false
            });
        }

        const row = new ActionRowBuilder().addComponents(
            reports.map(report =>
                new ButtonBuilder()
                    .setCustomId(`mod_resolve_${report.id}`)
                    .setLabel(`Resolve #${report.id}`)
                    .setStyle(ButtonStyle.Primary)
            )
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
    }

    async function resolveTradeReport(interaction, reportId, action) {
        await interaction.deferReply();
        const moderatorId = interaction.user.id;
        const guildId = interaction.guild.id;

        let result;
        try {
            result = await hub.api('POST', `/tradebot/report/${reportId}/resolve`, {
                action,
                moderator_id: moderatorId,
                guild_id: guildId
            });
        } catch (err) {
            if (err.status === 404) {
                return interaction.editReply({ content: '❌ Report not found!' });
            }
            if (err.status === 409) {
                return interaction.editReply({ content: '❌ This report has already been resolved!' });
            }
            throw err;
        }

        const embed = new EmbedBuilder()
            .setTitle('✅ Report Resolved')
            .addFields(
                { name: 'Report ID', value: `#${reportId}`, inline: true },
                { name: 'Trade ID', value: `#${result.report.trade_id}`, inline: true },
                { name: 'Action Taken', value: result.actionDescription, inline: false },
                { name: 'Resolved By', value: `<@${moderatorId}>`, inline: true }
            )
            .setColor('#00ff00');

        await interaction.editReply({ embeds: [embed] });
    }

    async function deleteTrade(interaction, tradeId, reason) {
        await interaction.deferReply();
        const moderatorId = interaction.user.id;

        let result;
        try {
            result = await hub.api('DELETE', `/tradebot/trade/${tradeId}`);
        } catch (err) {
            if (err.status === 404) {
                return interaction.editReply({ content: '❌ Trade not found!' });
            }
            throw err;
        }

        const trade = result.trade;
        const userMap = await buildUserMap(interaction.client, [trade.initiator_id, trade.recipient_id]);
        const formatId = id => isMcUuid(id)
            ? `[${userMap.get(id) || id}](https://namemc.com/profile/${id})`
            : `<@${id}>`;
        const embed = new EmbedBuilder()
            .setTitle('🗑️ Trade Deleted')
            .addFields(
                { name: 'Trade ID', value: `#${tradeId}`, inline: true },
                { name: 'Deleted By', value: `<@${moderatorId}>`, inline: true },
                { name: 'Reason', value: reason, inline: false },
                { name: 'Original Trade', value: `Between ${formatId(trade.initiator_id)} and ${formatId(trade.recipient_id)}\n${trade.description}`, inline: false }
            )
            .setColor('#ff0000');

        await interaction.editReply({ embeds: [embed] });
    }

    async function showUserWarnings(interaction, user) {
        await interaction.deferReply();
        const warnings = await hub.api('GET', `/tradebot/user/${user.id}/warnings`);

        const embed = new EmbedBuilder()
            .setTitle(`⚠️ Warnings for ${user.displayName || user.username}`)
            .setColor('#ff9900');

        if (!warnings.length) {
            embed.setDescription('No warnings found for this user.');
        } else {
            embed.setDescription(`Total warnings: ${warnings.length}`);
            for (const warning of warnings.slice(0, 5)) {
                embed.addFields({
                    name: `Warning #${warning.id}`,
                    value: `**Reason:** ${warning.reason}\n**By:** <@${warning.moderator_id}>\n**Date:** <t:${toUnix(warning.created_at)}:R>`,
                    inline: false
                });
            }
            if (warnings.length > 5) {
                embed.setFooter({ text: `Showing 5 of ${warnings.length} warnings` });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    async function markScammer(interaction, user, reason) {
        await interaction.deferReply();
        const moderatorId = interaction.user.id;
        const guildId = interaction.guild.id;

        try {
            await hub.api('POST', '/tradebot/scammer', {
                user_id: user.id,
                moderator_id: moderatorId,
                reason,
                guild_id: guildId
            });

            const embed = new EmbedBuilder()
                .setTitle('🚨 User Marked as Scammer')
                .addFields(
                    { name: 'User', value: `<@${user.id}>`, inline: true },
                    { name: 'Marked By', value: `<@${moderatorId}>`, inline: true },
                    { name: 'Reason', value: reason, inline: false }
                )
                .setColor('#ff0000')
                .setFooter({ text: '⚠️ This user is now flagged in all trade interactions' });

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            await interaction.editReply({ content: '❌ Error marking user as scammer.' });
        }
    }

    async function unmarkScammer(interaction, user, mcUuid = null) {
        await interaction.deferReply();
        const moderatorId = interaction.user.id;
        const targetId = mcUuid || user.id;

        let result;
        try {
            result = await hub.api('DELETE', `/tradebot/scammer/${targetId}`);
        } catch (err) {
            if (err.status === 404) {
                return interaction.editReply({ content: '❌ This user is not marked as a scammer.' });
            }
            throw err;
        }

        const scammer = result.scammer;
        let userDisplay;
        if (isMcUuid(targetId)) {
            const data = await hub.api('GET', `/tradebot/mc-username/${targetId}`).catch(() => null);
            const name = data?.username || targetId;
            userDisplay = `[${name}](https://namemc.com/profile/${targetId})`;
        } else {
            userDisplay = `<@${targetId}>`;
        }

        const embed = new EmbedBuilder()
            .setTitle('✅ Scammer Mark Removed')
            .addFields(
                { name: 'User', value: userDisplay, inline: true },
                { name: 'Removed By', value: `<@${moderatorId}>`, inline: true },
                { name: 'Previously Marked For', value: scammer.reason, inline: false }
            )
            .setColor('#00ff00');

        await interaction.editReply({ embeds: [embed] });
    }

    async function getConfig(key) {
        const data = await hub.api('GET', `/tradebot/config/${key}`);
        return data.value;
    }

    async function setConfig(key, value) {
        await hub.api('POST', '/tradebot/config', { key, value });
    }

    function parseSinceDate(since) {
        const d = new Date(since);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    function csvCell(value) {
        const str = String(value);
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
    }

    const usernameCache = new Map();

    function isMcUuid(id) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    }

    async function buildUserMap(client, userIds) {
        const map = new Map();
        const newDiscord = [];
        await Promise.all([...new Set(userIds)].map(async id => {
            if (usernameCache.has(id)) {
                map.set(id, usernameCache.get(id));
                return;
            }
            let name;
            if (isMcUuid(id)) {
                const data = await hub.api('GET', `/tradebot/mc-username/${id}`).catch(() => null);
                name = data?.username || id;
            } else {
                const user = await client.users.fetch(id).catch(() => null);
                name = user ? (user.globalName || user.username) : id;
                if (name !== id) newDiscord.push({ user_id: id, username: name });
            }
            usernameCache.set(id, name);
            map.set(id, name);
        }));
        if (newDiscord.length > 0) {
            hub.api('POST', '/tradebot/discord-username', newDiscord).catch(() => {});
        }
        return map;
    }

    async function exportTradeSummary(interaction, sinceInput) {
        await interaction.deferReply();

        let sinceParam = '';
        let sinceLabel;
        if (sinceInput) {
            if (!parseSinceDate(sinceInput)) {
                return interaction.editReply({ content: '❌ Invalid date format. Use YYYY-MM-DD.' });
            }
            sinceParam = `?since=${encodeURIComponent(sinceInput)}`;
            sinceLabel = `since ${sinceInput.slice(0, 10)}`;
        }

        const { rows, sinceMs } = await hub.api('GET', `/tradebot/export/summary${sinceParam}`);

        if (!sinceLabel) {
            sinceLabel = sinceMs ? `since ${new Date(sinceMs).toISOString().slice(0, 10)}` : 'all time (no previous export)';
        }

        if (!rows.length) {
            return interaction.editReply({ content: '❌ No trade data found.' });
        }

        const userMap = await buildUserMap(interaction.client, rows.map(r => r.user_id));

        const csv = 'username,user_id,total_trades,confirmed,rejected,cancelled,pending,new_confirmed\n'
            + rows.map(r => [csvCell(userMap.get(r.user_id)), r.user_id, r.total_trades, r.confirmed, r.rejected, r.cancelled, r.pending, r.new_confirmed].join(',')).join('\n');

        await setConfig('last_export_at', String(Date.now()));

        const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf-8'), { name: 'trade_summary.csv' });
        await interaction.editReply({ content: `📊 Trade summary — ${rows.length} users (new trades ${sinceLabel})`, files: [attachment] });
    }

    async function exportFullStats(interaction, sinceInput) {
        await interaction.deferReply();

        let sinceParam = '';
        let sinceLabel;
        if (sinceInput) {
            if (!parseSinceDate(sinceInput)) {
                return interaction.editReply({ content: '❌ Invalid date format. Use YYYY-MM-DD.' });
            }
            sinceParam = `?since=${encodeURIComponent(sinceInput)}`;
            sinceLabel = `since ${sinceInput.slice(0, 10)}`;
        }

        const { rows, sinceMs } = await hub.api('GET', `/tradebot/export/full${sinceParam}`);

        if (!sinceLabel) {
            sinceLabel = sinceMs ? `since ${new Date(sinceMs).toISOString().slice(0, 10)}` : 'all time (no previous export)';
        }

        if (!rows.length) {
            return interaction.editReply({ content: '❌ No trade data found.' });
        }

        const userMap = await buildUserMap(interaction.client, rows.map(r => r.user_id));

        const csv = 'username,user_id,total_trades,confirmed,rejected,cancelled,pending,initiated,received,new_confirmed,success_rate_pct,warning_count,is_scammer\n'
            + rows.map(r => {
                const successRate = r.total_trades > 0 ? ((r.confirmed / r.total_trades) * 100).toFixed(1) : '0.0';
                return [csvCell(userMap.get(r.user_id)), r.user_id, r.total_trades, r.confirmed, r.rejected, r.cancelled, r.pending, r.initiated, r.received, r.new_confirmed, successRate, r.warning_count, r.is_scammer].join(',');
            }).join('\n');

        await setConfig('last_export_at', String(Date.now()));

        const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf-8'), { name: 'trade_stats_full.csv' });
        await interaction.editReply({ content: `📊 Full trade stats — ${rows.length} users (new trades ${sinceLabel})`, files: [attachment] });
    }

    async function showResolveActions(interaction, reportId) {
        await interaction.deferReply({ flags: 64 });
        let report;
        try {
            const data = await hub.api('GET', `/tradebot/report/${reportId}`);
            report = data.report;
        } catch (err) {
            if (err.status === 404) {
                return interaction.editReply({ content: '❌ Report not found!' });
            }
            throw err;
        }

        if (report.status === 'resolved') {
            return interaction.editReply({ content: '❌ Already resolved.' });
        }

        const tradeLabel = !report.trade_id ? 'User Report' : `Trade #${report.trade_id}`;
        const isUserReport = !report.trade_id;

        const embed = new EmbedBuilder()
            .setTitle(`🛡️ Resolve Report #${reportId}`)
            .addFields(
                { name: 'Reported User', value: `<@${report.reported_user_id}>`, inline: true },
                { name: 'Reporter', value: `<@${report.reporter_id}>`, inline: true },
                { name: 'Type', value: tradeLabel, inline: true },
                { name: 'Reason', value: report.reason, inline: false }
            )
            .setColor('#ff9900');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mod_action_${reportId}_dismiss`)
                .setLabel('Dismiss')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`mod_action_${reportId}_cancel`)
                .setLabel('Cancel Trade')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(isUserReport),
            new ButtonBuilder()
                .setCustomId(`mod_action_${reportId}_warn`)
                .setLabel('Warn User')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mod_action_${reportId}_mark_scammer`)
                .setLabel('Mark Scammer')
                .setStyle(ButtonStyle.Danger)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
    }

    async function handleResolveAction(interaction, reportId, action) {
        await interaction.deferUpdate();
        const moderatorId = interaction.user.id;
        const guildId = interaction.guild.id;

        let result;
        try {
            result = await hub.api('POST', `/tradebot/report/${reportId}/resolve`, {
                action,
                moderator_id: moderatorId,
                guild_id: guildId
            });
        } catch (err) {
            if (err.status === 404) {
                return interaction.editReply({ content: '❌ Report not found!', embeds: [], components: [] });
            }
            if (err.status === 409) {
                return interaction.editReply({ content: '❌ Already resolved.', embeds: [], components: [] });
            }
            throw err;
        }

        const embed = new EmbedBuilder()
            .setTitle('✅ Report Resolved')
            .addFields(
                { name: 'Report ID', value: `#${reportId}`, inline: true },
                { name: 'Action Taken', value: result.actionDescription, inline: false },
                { name: 'Resolved By', value: `<@${moderatorId}>`, inline: true }
            )
            .setColor('#00ff00');

        await interaction.editReply({ embeds: [embed], components: [] });
    }

    async function postToVerifiedTrades(client, embed) {
        for (const guild of client.guilds.cache.values()) {
            const channel = guild.channels.cache.find(
                ch => ch.name.includes('verified-trade') && (ch.type === 0 || ch.type === 5)
            );
            if (channel) {
                await channel.send({ embeds: [embed] }).catch(err =>
                    console.error(`[mod] Failed to post to #${channel.name} in ${guild.name}:`, err.message)
                );
            }
        }
    }

    async function resolveDisplayName(targetId, mcUuid) {
        if (mcUuid) {
            const data = await hub.api('GET', `/tradebot/mc-username/${mcUuid}`).catch(() => null);
            const name = data?.username || mcUuid;
            return { display: `[${name}](https://namemc.com/profile/${mcUuid})`, name };
        }
        return { display: `<@${targetId}>`, name: targetId };
    }

    async function resetUserTrades(interaction, user, mcUuid = null) {
        await interaction.deferReply();
        const moderatorId = interaction.user.id;
        const targetId = mcUuid || user.id;
        const reason = interaction.options.getString('details');
        const { display, name } = await resolveDisplayName(targetId, mcUuid);
        let result;
        try {
            result = await hub.api('POST', `/tradebot/user/${targetId}/void-trades`, { reason });
        } catch (err) {
            console.error(`[resetUserTrades] Hub error for ${targetId}:`, err?.status, err?.message, err);
            return interaction.editReply({ content: `❌ Error voiding trades. (${err?.status ?? err?.message ?? 'unknown'})` });
        }
        const embed = new EmbedBuilder()
            .setTitle('🔄 Trades Reset')
            .addFields(
                { name: 'User', value: display, inline: true },
                { name: 'Reset By', value: `<@${moderatorId}>`, inline: true },
                { name: 'Trades Voided', value: String(result.affected), inline: true },
                { name: 'Reason', value: reason, inline: false }
            )
            .setDescription('Trades are soft-hidden. Use "Unreset User Trades" to restore.')
            .setColor('#ff9900');
        await interaction.editReply({ embeds: [embed] });
        const announceEmbed = new EmbedBuilder()
            .setTitle('🔄 Trade History Reset')
            .setDescription(`${display}'s trades have been reset by moderation.\n**Reason:** ${reason}`)
            .setColor('#ff9900');
        await postToVerifiedTrades(interaction.client, announceEmbed);
    }

    async function unresetUserTrades(interaction, user, mcUuid = null) {
        await interaction.deferReply();
        const moderatorId = interaction.user.id;
        const targetId = mcUuid || user.id;
        const reason = interaction.options.getString('details');
        const { display } = await resolveDisplayName(targetId, mcUuid);
        let result;
        try {
            result = await hub.api('POST', `/tradebot/user/${targetId}/unvoid-trades`, { reason });
        } catch (err) {
            console.error(`[unresetUserTrades] Hub error for ${targetId}:`, err?.status, err?.message, err);
            return interaction.editReply({ content: `❌ Error restoring trades. (${err?.status ?? err?.message ?? 'unknown'})` });
        }
        const embed = new EmbedBuilder()
            .setTitle('✅ Trades Restored')
            .addFields(
                { name: 'User', value: display, inline: true },
                { name: 'Restored By', value: `<@${moderatorId}>`, inline: true },
                { name: 'Trades Restored', value: String(result.affected), inline: true },
                { name: 'Reason', value: reason, inline: false }
            )
            .setColor('#00ff00');
        await interaction.editReply({ embeds: [embed] });
        const announceEmbed = new EmbedBuilder()
            .setTitle('✅ Trade History Restored')
            .setDescription(`${display}'s trades have been restored by moderation.\n**Reason:** ${reason}`)
            .setColor('#00ff00');
        await postToVerifiedTrades(interaction.client, announceEmbed);
    }

    async function exportScammers(interaction) {
        await interaction.deferReply({ flags: 64 });
        const data = await hub.api('GET', '/tradebot/scammers');
        const scammers = data?.scammers ?? [];

        if (!scammers.length) {
            return interaction.editReply('✅ No scammers on record.');
        }

        const csv = 'player_name,user_id,reason,marked_at\n'
            + scammers.map(s => [
                csvCell(s.player_name),
                csvCell(s.user_id),
                csvCell(s.reason),
                csvCell(new Date(Number(s.created_at)).toISOString())
            ].join(',')).join('\n');

        const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf-8'), { name: 'scammers.csv' });
        await interaction.editReply({ content: `🚨 ${scammers.length} scammer(s) on record`, files: [attachment] });
    }

    return { checkModeratorPermission, showModeratedTrades, resolveTradeReport, deleteTrade, showUserWarnings, markScammer, unmarkScammer, exportTradeSummary, exportFullStats, showResolveActions, handleResolveAction, exportScammers, resetUserTrades, unresetUserTrades };
}

module.exports = init;
