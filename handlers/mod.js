const { EmbedBuilder } = require('discord.js');

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
        const guildId = interaction.guild.id;

        let query = `
            SELECT tr.*, t.initiator_id, t.recipient_id, t.description, t.status as trade_status
            FROM trade_reports tr
            LEFT JOIN trades t ON tr.trade_id = t.id
            WHERE tr.guild_id = ?
        `;
        const params = [guildId];

        if (status !== 'all') {
            query += ' AND tr.status = ?';
            params.push(status);
        }

        query += ' ORDER BY tr.created_at DESC LIMIT 10';

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
            const createdTimestamp = Math.floor(new Date(report.created_at + 'Z').getTime() / 1000);

            embed.addFields({
                name: `${statusEmoji} Report #${report.id} - Trade #${report.trade_id}`,
                value: `**Reporter:** <@${report.reporter_id}>\n**Reported:** <@${report.reported_user_id}>\n**Reason:** ${report.reason}\n**Created:** <t:${createdTimestamp}:R>`,
                inline: false
            });
        }

        embed.setFooter({ text: 'Use /mod action:resolve id:<reportid> reason:<action> to handle reports' });

        await interaction.reply({ embeds: [embed] });
    }

    async function resolveTradeReport(interaction, reportId, action) {
        const moderatorId = interaction.user.id;
        const guildId = interaction.guild.id;

        const report = await new Promise((resolve, reject) => {
            db.get(`
                SELECT tr.*, t.initiator_id, t.recipient_id, t.description, t.status as trade_status
                FROM trade_reports tr
                JOIN trades t ON tr.trade_id = t.id
                WHERE tr.id = ? AND tr.guild_id = ?
            `, [reportId, guildId], (err, row) => {
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
            await new Promise((resolve, reject) => {
                db.run('UPDATE trades SET status = "cancelled" WHERE id = ?', [report.trade_id], (err) => err ? reject(err) : resolve());
            });
            actionDescription = 'Trade cancelled due to report';
        } else if (action === 'warn') {
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO user_warnings (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [report.reported_user_id, moderatorId, `Trade report: ${report.reason}`, guildId],
                    (err) => err ? reject(err) : resolve()
                );
            });
            await new Promise((resolve, reject) => {
                db.run('UPDATE trades SET status = "cancelled" WHERE id = ?', [report.trade_id], (err) => err ? reject(err) : resolve());
            });
            actionDescription = 'User warned and trade cancelled';
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
        const guildId = interaction.guild.id;

        const trade = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM trades WHERE id = ? AND guild_id = ?',
                [tradeId, guildId],
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
        const guildId = interaction.guild.id;

        const warnings = await new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM user_warnings WHERE user_id = ? AND guild_id = ? ORDER BY created_at DESC',
                [user.id, guildId],
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
        const guildId = interaction.guild.id;

        const scammer = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                [user.id, guildId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!scammer) {
            return interaction.reply({ content: '❌ This user is not marked as a scammer.', ephemeral: true });
        }

        await new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                [user.id, guildId],
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

    return { checkModeratorPermission, showModeratedTrades, resolveTradeReport, deleteTrade, showUserWarnings, markScammer, unmarkScammer };
}

module.exports = init;
