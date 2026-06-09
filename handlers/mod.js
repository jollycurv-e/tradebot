const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { debug } = require('../utils.js');

function toUnix(field) {
    if (!field) return null;
    const ts = field.endsWith('Z') ? field : field.replace(' ', 'T') + 'Z';
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
        const reports = await hub.api('GET', `/tradebot/reports?status=${status}`);

        if (!reports.length) {
            const embed = new EmbedBuilder()
                .setTitle('🛡️ Trade Reports')
                .setDescription(`No ${status === 'all' ? '' : status} reports found.`)
                .setColor('#0099ff');
            return interaction.reply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
            .setTitle('🛡️ Trade Reports')
            .setDescription(`Showing ${reports.length} ${status === 'all' ? '' : status} reports`)
            .setColor('#ff9900');

        for (const report of reports) {
            const statusEmoji = report.status === 'pending' ? '⏳' : '✅';
            const createdTimestamp = toUnix(report.created_at);
            const tradeLabel = !report.trade_id ? 'User Report' : `Trade #${report.trade_id}`;

            embed.addFields({
                name: `${statusEmoji} Report #${report.id} - ${tradeLabel}`,
                value: `**Reporter:** <@${report.reporter_id}>\n**Reported:** <@${report.reported_user_id}>\n**Reason:** ${report.reason}\n**Created:** <t:${createdTimestamp}:R>`,
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

        await interaction.reply({ embeds: [embed], components: [row] });
    }

    async function resolveTradeReport(interaction, reportId, action) {
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
                return interaction.reply({ content: '❌ Report not found!', flags: 64 });
            }
            if (err.status === 409) {
                return interaction.reply({ content: '❌ This report has already been resolved!', flags: 64 });
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

        await interaction.reply({ embeds: [embed] });
    }

    async function deleteTrade(interaction, tradeId, reason) {
        const moderatorId = interaction.user.id;

        let result;
        try {
            result = await hub.api('DELETE', `/tradebot/trade/${tradeId}`);
        } catch (err) {
            if (err.status === 404) {
                return interaction.reply({ content: '❌ Trade not found!', flags: 64 });
            }
            throw err;
        }

        const trade = result.trade;
        const embed = new EmbedBuilder()
            .setTitle('🗑️ Trade Deleted')
            .addFields(
                { name: 'Trade ID', value: `#${tradeId}`, inline: true },
                { name: 'Deleted By', value: `<@${moderatorId}>`, inline: true },
                { name: 'Reason', value: reason, inline: false },
                { name: 'Original Trade', value: `Between <@${trade.initiator_id}> and <@${trade.recipient_id}>\n${trade.description}`, inline: false }
            )
            .setColor('#ff0000');

        await interaction.reply({ embeds: [embed] });
    }

    async function showUserWarnings(interaction, user) {
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

        await interaction.reply({ embeds: [embed] });
    }

    async function markScammer(interaction, user, reason) {
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

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            await interaction.reply({ content: '❌ Error marking user as scammer.', flags: 64 });
        }
    }

    async function unmarkScammer(interaction, user) {
        const moderatorId = interaction.user.id;

        let result;
        try {
            result = await hub.api('DELETE', `/tradebot/scammer/${user.id}`);
        } catch (err) {
            if (err.status === 404) {
                return interaction.reply({ content: '❌ This user is not marked as a scammer.', flags: 64 });
            }
            throw err;
        }

        const scammer = result.scammer;
        const embed = new EmbedBuilder()
            .setTitle('✅ Scammer Mark Removed')
            .addFields(
                { name: 'User', value: `<@${user.id}>`, inline: true },
                { name: 'Removed By', value: `<@${moderatorId}>`, inline: true },
                { name: 'Previously Marked For', value: scammer.reason, inline: false }
            )
            .setColor('#00ff00');

        await interaction.reply({ embeds: [embed] });
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

    async function buildUserMap(client, userIds) {
        const map = new Map();
        await Promise.all([...new Set(userIds)].map(async id => {
            if (usernameCache.has(id)) {
                map.set(id, usernameCache.get(id));
                return;
            }
            const user = await client.users.fetch(id).catch(() => null);
            const name = user ? (user.globalName || user.username) : id;
            usernameCache.set(id, name);
            map.set(id, name);
        }));
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

        const { rows, sinceTs } = await hub.api('GET', `/tradebot/export/summary${sinceParam}`);

        if (!sinceLabel) {
            sinceLabel = sinceTs ? `since ${sinceTs.slice(0, 10)}` : 'all time (no previous export)';
        }

        if (!rows.length) {
            return interaction.editReply({ content: '❌ No trade data found.' });
        }

        const userMap = await buildUserMap(interaction.client, rows.map(r => r.user_id));

        const csv = 'username,user_id,total_trades,confirmed,rejected,cancelled,pending,new_confirmed\n'
            + rows.map(r => [csvCell(userMap.get(r.user_id)), r.user_id, r.total_trades, r.confirmed, r.rejected, r.cancelled, r.pending, r.new_confirmed].join(',')).join('\n');

        await setConfig('last_export_at', new Date().toISOString());

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

        const { rows, sinceTs } = await hub.api('GET', `/tradebot/export/full${sinceParam}`);

        if (!sinceLabel) {
            sinceLabel = sinceTs ? `since ${sinceTs.slice(0, 10)}` : 'all time (no previous export)';
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

        await setConfig('last_export_at', new Date().toISOString());

        const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf-8'), { name: 'trade_stats_full.csv' });
        await interaction.editReply({ content: `📊 Full trade stats — ${rows.length} users (new trades ${sinceLabel})`, files: [attachment] });
    }

    async function showResolveActions(interaction, reportId) {
        let report;
        try {
            const data = await hub.api('GET', `/tradebot/report/${reportId}`);
            report = data.report;
        } catch (err) {
            if (err.status === 404) {
                return interaction.reply({ content: '❌ Report not found!', flags: 64 });
            }
            throw err;
        }

        if (report.status === 'resolved') {
            return interaction.reply({ content: '❌ Already resolved.', flags: 64 });
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

        await interaction.reply({ embeds: [embed], components: [row], flags: 64 });
    }

    async function handleResolveAction(interaction, reportId, action) {
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
                return interaction.update({ content: '❌ Report not found!', embeds: [], components: [] });
            }
            if (err.status === 409) {
                return interaction.update({ content: '❌ Already resolved.', embeds: [], components: [] });
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

        await interaction.update({ embeds: [embed], components: [] });
    }

    return { checkModeratorPermission, showModeratedTrades, resolveTradeReport, deleteTrade, showUserWarnings, markScammer, unmarkScammer, exportTradeSummary, exportFullStats, showResolveActions, handleResolveAction };
}

module.exports = init;
