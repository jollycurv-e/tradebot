const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function init(db) {
    async function checkModeratorPermission(interaction) {
        if (!interaction.member.permissions.has('ManageMessages') && !interaction.member.permissions.has('Administrator')) {
            await interaction.reply({
                content: '❌ You need "Manage Messages" or "Administrator" permissions to use moderation commands.',
                ephemeral: true
            });
            return false;
        }
        return true;
    }

    async function showModeratedTrades(interaction, status) {
        let query = `
            SELECT tr.*, t.initiator_id, t.recipient_id, t.description, t.status as trade_status
            FROM trade_reports tr
            LEFT JOIN trades t ON tr.trade_id = t.id
        `;
        const params = [];

        if (status !== 'all') {
            query += ' WHERE tr.status = ?';
            params.push(status);
        }

        query += ' ORDER BY tr.created_at DESC LIMIT 5';

        const reports = await new Promise((resolve, reject) => {
            db.all(query, params, (err, rows) => {
                err ? reject(err) : resolve(rows);
            });
        });

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
            const createdAt = report.created_at.endsWith('Z') ? report.created_at : report.created_at.replace(' ', 'T') + 'Z';
            const createdTimestamp = Math.floor(new Date(createdAt).getTime() / 1000);
            const tradeLabel = report.trade_id === 0 ? 'User Report' : `Trade #${report.trade_id}`;

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

        const report = await new Promise((resolve, reject) => {
            db.get(`
                SELECT tr.*, t.initiator_id, t.recipient_id, t.description, t.status as trade_status
                FROM trade_reports tr
                LEFT JOIN trades t ON tr.trade_id = t.id
                WHERE tr.id = ?
            `, [reportId], (err, row) => {
                err ? reject(err) : resolve(row);
            });
        });

        if (!report) {
            return interaction.reply({ content: '❌ Report not found!', ephemeral: true });
        }

        if (report.status === 'resolved') {
            return interaction.reply({ content: '❌ This report has already been resolved!', ephemeral: true });
        }

        const now = new Date().toISOString();
        let actionDescription = '';

        if (action === 'dismiss') {
            actionDescription = 'Report dismissed - no action taken';
        } else if (action === 'cancel') {
            if (report.trade_id) {
                await new Promise((resolve, reject) => {
                    db.run('UPDATE trades SET status = "cancelled" WHERE id = ?', [report.trade_id], (err) => err ? reject(err) : resolve());
                });
            }
            actionDescription = 'Trade cancelled due to report';
        } else if (action === 'warn') {
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO user_warnings (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [report.reported_user_id, moderatorId, `Trade report: ${report.reason}`, guildId],
                    (err) => err ? reject(err) : resolve()
                );
            });
            if (report.trade_id) {
                await new Promise((resolve, reject) => {
                    db.run('UPDATE trades SET status = "cancelled" WHERE id = ?', [report.trade_id], (err) => err ? reject(err) : resolve());
                });
            }
            actionDescription = 'User warned and trade cancelled';
        } else if (action === 'mark_scammer') {
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT OR REPLACE INTO scammer_list (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [report.reported_user_id, moderatorId, `Trade report: ${report.reason}`, guildId],
                    (err) => err ? reject(err) : resolve()
                );
            });
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO user_warnings (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [report.reported_user_id, moderatorId, `Marked as scammer via trade report: ${report.reason}`, guildId],
                    (err) => err ? reject(err) : resolve()
                );
            });
            if (report.trade_id) {
                await new Promise((resolve, reject) => {
                    db.run('UPDATE trades SET status = "cancelled" WHERE id = ?', [report.trade_id], (err) => err ? reject(err) : resolve());
                });
            }
            actionDescription = 'User marked as scammer, warned, and trade cancelled';
        }

        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE trade_reports SET status = "resolved", resolved_at = ?, resolved_by = ? WHERE id = ?',
                [now, moderatorId, reportId],
                (err) => err ? reject(err) : resolve()
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('✅ Report Resolved')
            .addFields(
                { name: 'Report ID', value: `#${reportId}`, inline: true },
                { name: 'Trade ID', value: `#${report.trade_id}`, inline: true },
                { name: 'Action Taken', value: actionDescription, inline: false },
                { name: 'Resolved By', value: `<@${moderatorId}>`, inline: true }
            )
            .setColor('#00ff00');

        await interaction.reply({ embeds: [embed] });
    }

    async function deleteTrade(interaction, tradeId, reason) {
        const moderatorId = interaction.user.id;

        const trade = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM trades WHERE id = ?',
                [tradeId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!trade) {
            return interaction.reply({ content: '❌ Trade not found!', ephemeral: true });
        }

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM trade_confirmations WHERE trade_id = ?', [tradeId], (err) => err ? reject(err) : resolve());
        });

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM trades WHERE id = ?', [tradeId], (err) => err ? reject(err) : resolve());
        });

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
        const warnings = await new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM user_warnings WHERE user_id = ? ORDER BY created_at DESC',
                [user.id],
                (err, rows) => err ? reject(err) : resolve(rows)
            );
        });

        const embed = new EmbedBuilder()
            .setTitle(`⚠️ Warnings for ${user.displayName || user.username}`)
            .setColor('#ff9900');

        if (!warnings.length) {
            embed.setDescription('No warnings found for this user.');
        } else {
            embed.setDescription(`Total warnings: ${warnings.length}`);

            for (const warning of warnings.slice(0, 5)) {
                const createdTimestamp = Math.floor(new Date(warning.created_at + 'Z').getTime() / 1000);
                embed.addFields({
                    name: `Warning #${warning.id}`,
                    value: `**Reason:** ${warning.reason}\n**By:** <@${warning.moderator_id}>\n**Date:** <t:${createdTimestamp}:R>`,
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
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT OR REPLACE INTO scammer_list (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [user.id, moderatorId, reason, guildId],
                    (err) => err ? reject(err) : resolve()
                );
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
            await interaction.reply({ content: '❌ Error marking user as scammer.', ephemeral: true });
        }
    }

    async function unmarkScammer(interaction, user) {
        const moderatorId = interaction.user.id;

        const scammer = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM scammer_list WHERE user_id = ?',
                [user.id],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!scammer) {
            return interaction.reply({ content: '❌ This user is not marked as a scammer.', ephemeral: true });
        }

        await new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM scammer_list WHERE user_id = ?',
                [user.id],
                (err) => err ? reject(err) : resolve()
            );
        });

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
        return new Promise((resolve, reject) => {
            db.get('SELECT value FROM config WHERE key = ?', [key], (err, row) => err ? reject(err) : resolve(row ? row.value : null));
        });
    }

    async function setConfig(key, value) {
        return new Promise((resolve, reject) => {
            db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, value], (err) => err ? reject(err) : resolve());
        });
    }

    function parseSinceDate(since) {
        const d = new Date(since);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    function csvCell(value) {
        const str = String(value);
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
    }

    async function buildUserMap(client, userIds) {
        const map = new Map();
        await Promise.all([...new Set(userIds)].map(async id => {
            const user = await client.users.fetch(id).catch(() => null);
            map.set(id, user ? (user.globalName || user.username) : id);
        }));
        return map;
    }

    async function exportTradeSummary(interaction, sinceInput) {
        await interaction.deferReply();

        let sinceTs = sinceInput ? parseSinceDate(sinceInput) : await getConfig('last_export_at');
        if (sinceInput && !sinceTs) {
            return interaction.editReply({ content: '❌ Invalid date format. Use YYYY-MM-DD.' });
        }
        const sinceLabel = sinceTs ? `since ${sinceTs.slice(0, 10)}` : 'all time (no previous export)';

        const rows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT
                    user_id,
                    COUNT(*) as total_trades,
                    SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
                    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
                    SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN status = 'confirmed' AND confirmed_at >= ? THEN 1 ELSE 0 END) as new_confirmed
                FROM (
                    SELECT initiator_id as user_id, status, confirmed_at FROM trades
                    UNION ALL
                    SELECT recipient_id as user_id, status, confirmed_at FROM trades
                )
                GROUP BY user_id
                ORDER BY total_trades DESC
            `, [sinceTs || '1970-01-01T00:00:00.000Z'], (err, rows) => err ? reject(err) : resolve(rows));
        });

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

        let sinceTs = sinceInput ? parseSinceDate(sinceInput) : await getConfig('last_export_at');
        if (sinceInput && !sinceTs) {
            return interaction.editReply({ content: '❌ Invalid date format. Use YYYY-MM-DD.' });
        }
        const sinceLabel = sinceTs ? `since ${sinceTs.slice(0, 10)}` : 'all time (no previous export)';

        const rows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT
                    t.user_id,
                    COUNT(*) as total_trades,
                    SUM(CASE WHEN t.status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
                    SUM(CASE WHEN t.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
                    SUM(CASE WHEN t.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
                    SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN t.is_initiator = 1 THEN 1 ELSE 0 END) as initiated,
                    SUM(CASE WHEN t.is_initiator = 0 THEN 1 ELSE 0 END) as received,
                    SUM(CASE WHEN t.status = 'confirmed' AND t.confirmed_at >= ? THEN 1 ELSE 0 END) as new_confirmed,
                    COALESCE(w.warning_count, 0) as warning_count,
                    CASE WHEN s.user_id IS NOT NULL THEN 1 ELSE 0 END as is_scammer
                FROM (
                    SELECT initiator_id as user_id, status, confirmed_at, 1 as is_initiator FROM trades
                    UNION ALL
                    SELECT recipient_id as user_id, status, confirmed_at, 0 as is_initiator FROM trades
                ) t
                LEFT JOIN (
                    SELECT user_id, COUNT(*) as warning_count FROM user_warnings GROUP BY user_id
                ) w ON t.user_id = w.user_id
                LEFT JOIN scammer_list s ON t.user_id = s.user_id
                GROUP BY t.user_id
                ORDER BY total_trades DESC
            `, [sinceTs || '1970-01-01T00:00:00.000Z'], (err, rows) => err ? reject(err) : resolve(rows));
        });

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
        const report = await new Promise((resolve, reject) => {
            db.get(`
                SELECT tr.*, t.initiator_id, t.recipient_id, t.description, t.status as trade_status
                FROM trade_reports tr
                LEFT JOIN trades t ON tr.trade_id = t.id
                WHERE tr.id = ?
            `, [reportId], (err, row) => err ? reject(err) : resolve(row));
        });

        if (!report) return interaction.reply({ content: '❌ Report not found!', ephemeral: true });
        if (report.status === 'resolved') return interaction.reply({ content: '❌ Already resolved.', ephemeral: true });

        const tradeLabel = report.trade_id === 0 ? 'User Report' : `Trade #${report.trade_id}`;
        const isUserReport = report.trade_id === 0;

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

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    async function handleResolveAction(interaction, reportId, action) {
        const moderatorId = interaction.user.id;
        const guildId = interaction.guild.id;

        const report = await new Promise((resolve, reject) => {
            db.get(`
                SELECT tr.*, t.initiator_id, t.recipient_id, t.description, t.status as trade_status
                FROM trade_reports tr
                LEFT JOIN trades t ON tr.trade_id = t.id
                WHERE tr.id = ?
            `, [reportId], (err, row) => err ? reject(err) : resolve(row));
        });

        if (!report) return interaction.update({ content: '❌ Report not found!', embeds: [], components: [] });
        if (report.status === 'resolved') return interaction.update({ content: '❌ Already resolved.', embeds: [], components: [] });

        let actionDescription = '';

        if (action === 'dismiss') {
            actionDescription = 'Report dismissed — no action taken';
        } else if (action === 'cancel') {
            if (report.trade_id) {
                await new Promise((resolve, reject) => {
                    db.run('UPDATE trades SET status = "cancelled" WHERE id = ?', [report.trade_id], (err) => err ? reject(err) : resolve());
                });
            }
            actionDescription = 'Trade cancelled';
        } else if (action === 'warn') {
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO user_warnings (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [report.reported_user_id, moderatorId, `Trade report: ${report.reason}`, guildId],
                    (err) => err ? reject(err) : resolve()
                );
            });
            if (report.trade_id) {
                await new Promise((resolve, reject) => {
                    db.run('UPDATE trades SET status = "cancelled" WHERE id = ?', [report.trade_id], (err) => err ? reject(err) : resolve());
                });
            }
            actionDescription = 'User warned and trade cancelled';
        } else if (action === 'mark_scammer') {
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT OR REPLACE INTO scammer_list (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [report.reported_user_id, moderatorId, `Trade report: ${report.reason}`, guildId],
                    (err) => err ? reject(err) : resolve()
                );
            });
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO user_warnings (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [report.reported_user_id, moderatorId, `Marked as scammer via trade report: ${report.reason}`, guildId],
                    (err) => err ? reject(err) : resolve()
                );
            });
            if (report.trade_id) {
                await new Promise((resolve, reject) => {
                    db.run('UPDATE trades SET status = "cancelled" WHERE id = ?', [report.trade_id], (err) => err ? reject(err) : resolve());
                });
            }
            actionDescription = 'User marked as scammer, warned, and trade cancelled';
        }

        const now = new Date().toISOString();
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE trade_reports SET status = "resolved", resolved_at = ?, resolved_by = ? WHERE id = ?',
                [now, moderatorId, reportId],
                (err) => err ? reject(err) : resolve()
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('✅ Report Resolved')
            .addFields(
                { name: 'Report ID', value: `#${reportId}`, inline: true },
                { name: 'Action Taken', value: actionDescription, inline: false },
                { name: 'Resolved By', value: `<@${moderatorId}>`, inline: true }
            )
            .setColor('#00ff00');

        await interaction.update({ embeds: [embed], components: [] });
    }

    return { checkModeratorPermission, showModeratedTrades, resolveTradeReport, deleteTrade, showUserWarnings, markScammer, unmarkScammer, exportTradeSummary, exportFullStats, showResolveActions, handleResolveAction };
}

module.exports = init;
