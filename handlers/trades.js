const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { reply } = require('../utils');

function init(db) {
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

        const scammerCheck = await Promise.all([
            new Promise((resolve, reject) => {
                db.get(
                    'SELECT * FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                    [author.id, guild.id],
                    (err, row) => err ? reject(err) : resolve(row)
                );
            }),
            new Promise((resolve, reject) => {
                db.get(
                    'SELECT * FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                    [withUser.id, guild.id],
                    (err, row) => err ? reject(err) : resolve(row)
                );
            })
        ]);

        const [initiatorScammer, recipientScammer] = scammerCheck;

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

        const tradeId = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO trades (initiator_id, recipient_id, description, guild_id, channel_id) VALUES (?, ?, ?, ?, ?)',
                [author.id, withUser.id, description, guild.id, channel.id],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
        console.log(`[Database] Trade #${tradeId} created by ${author.tag} for ${withUser.tag}`);

        const now = new Date().toISOString();
        await Promise.all([
            new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO trade_confirmations (trade_id, user_id, confirmed, confirmed_at) VALUES (?, ?, TRUE, ?)',
                    [tradeId, author.id, now],
                    (err) => err ? reject(err) : resolve()
                );
            }),
            new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO trade_confirmations (trade_id, user_id) VALUES (?, ?)',
                    [tradeId, withUser.id],
                    (err) => err ? reject(err) : resolve()
                );
            })
        ]);

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

    async function handleConfirm(interaction, tradeId, userId, initiatorId, recipientId) {
        const tradeInfo = await new Promise((resolve, reject) => {
            db.get(
                'SELECT status FROM trades WHERE id = ?',
                [tradeId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (tradeInfo.status !== 'pending') {
            return interaction.reply({ content: '❌ This trade is no longer pending and cannot be confirmed.', ephemeral: true });
        }

        const existingConfirmation = await new Promise((resolve, reject) => {
            db.get(
                'SELECT confirmed FROM trade_confirmations WHERE trade_id = ? AND user_id = ?',
                [tradeId, userId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (existingConfirmation && existingConfirmation.confirmed) {
            return interaction.reply({ content: 'You have already confirmed this trade.', ephemeral: true });
        }

        const now = new Date().toISOString();
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE trade_confirmations SET confirmed = TRUE, confirmed_at = ? WHERE trade_id = ? AND user_id = ?',
                [now, tradeId, userId],
                (err) => err ? reject(err) : resolve()
            );
        });

        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE trades SET status = "confirmed", confirmed_at = ? WHERE id = ?',
                [now, tradeId],
                (err) => err ? reject(err) : resolve()
            );
        });

        const tradeDetails = await new Promise((resolve, reject) => {
            db.get(
                'SELECT initiator_id, recipient_id, description FROM trades WHERE id = ?',
                [tradeId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('✅ Trade Confirmed!')
            .setDescription('This trade has been confirmed and finalized!')
            .addFields({
                name: 'Trade Details',
                value: `**Between:** <@${tradeDetails.initiator_id}> ↔️ <@${tradeDetails.recipient_id}>\n**Description:** ${tradeDetails.description}\n**Confirmed:** <t:${Math.floor(Date.now() / 1000)}:R>`,
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
        const tradeInfo = await new Promise((resolve, reject) => {
            db.get(
                'SELECT status FROM trades WHERE id = ?',
                [tradeId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (tradeInfo.status !== 'pending') {
            return interaction.reply({ content: '❌ This trade is no longer pending and cannot be rejected.', ephemeral: true });
        }

        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE trades SET status = "rejected" WHERE id = ?',
                [tradeId],
                (err) => err ? reject(err) : resolve()
            );
        });

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
                return interaction.reply({ content: 'Only the recipient can confirm this trade.', ephemeral: true });
            }
            await handleConfirm(interaction, tradeId, userId, initiatorId, recipientId);
        } else if (action === 'reject') {
            if (userId !== initiatorId && userId !== recipientId) {
                return interaction.reply({ content: 'You cannot interact with this trade.', ephemeral: true });
            }
            await handleReject(interaction, tradeId);
        }
    }

    async function showTrades(context, user) {
        const guildId = context.guild.id;

        const trades = await new Promise((resolve, reject) => {
            db.all(`
                SELECT id, initiator_id, recipient_id, description, status, created_at, confirmed_at, expires_at
                FROM trades
                WHERE (initiator_id = ? OR recipient_id = ?) AND guild_id = ?
                ORDER BY created_at DESC
                LIMIT 10
            `, [user.id, user.id, guildId], (err, rows) => {
                err ? reject(err) : resolve(rows);
            });
        });

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

            const createdTimestamp = Math.floor(new Date(trade.created_at.endsWith('Z') ? trade.created_at : trade.created_at + 'Z').getTime() / 1000);
            const confirmedInfo = trade.confirmed_at ? `\n**Confirmed:** <t:${Math.floor(new Date(trade.confirmed_at.endsWith('Z') ? trade.confirmed_at : trade.confirmed_at + 'Z').getTime() / 1000)}:R>` : '';

            embed.addFields({
                name: `${statusEmoji} Trade #${trade.id} - ${trade.status.charAt(0).toUpperCase() + trade.status.slice(1)}`,
                value: `**${role}** with <@${otherUserId}>\n**Description:** ${trade.description}\n**Created:** <t:${createdTimestamp}:R>${confirmedInfo}`,
                inline: false
            });
        }

        await reply(context, { embeds: [embed] });
    }

    async function showTradeStats(context, user) {
        const guildId = context.guild.id;

        const stats = await new Promise((resolve, reject) => {
            db.get(`
                SELECT
                    COUNT(*) as total_trades,
                    SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_trades,
                    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_trades,
                    SUM(CASE WHEN initiator_id = ? THEN 1 ELSE 0 END) as initiated_trades
                FROM trades
                WHERE (initiator_id = ? OR recipient_id = ?) AND guild_id = ?
            `, [user.id, user.id, user.id, guildId], (err, row) => {
                err ? reject(err) : resolve(row);
            });
        });

        const partners = await new Promise((resolve, reject) => {
            db.all(`
                SELECT
                    CASE
                        WHEN initiator_id = ? THEN recipient_id
                        ELSE initiator_id
                    END as partner_id,
                    COUNT(*) as trade_count
                FROM trades
                WHERE (initiator_id = ? OR recipient_id = ?) AND guild_id = ? AND status = 'confirmed'
                GROUP BY partner_id
                ORDER BY trade_count DESC
                LIMIT 3
            `, [user.id, user.id, user.id, guildId], (err, rows) => {
                err ? reject(err) : resolve(rows);
            });
        });

        const warnings = await new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM user_warnings WHERE user_id = ? AND guild_id = ? ORDER BY created_at DESC LIMIT 5',
                [user.id, guildId],
                (err, rows) => err ? reject(err) : resolve(rows)
            );
        });

        const scammerStatus = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                [user.id, guildId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

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
                value: partners.map(p => `<@${p.partner_id}>: ${p.trade_count} trades`).join('\n'),
                inline: false
            });
        }

        if (scammerStatus) {
            const markedTimestamp = Math.floor(new Date(scammerStatus.marked_at + 'Z').getTime() / 1000);
            embed.addFields({
                name: '🚨 SCAMMER WARNING',
                value: `**Reason:** ${scammerStatus.reason}\n**Marked:** <t:${markedTimestamp}:R>\n**By:** <@${scammerStatus.moderator_id}>`,
                inline: false
            });
        }

        if (warnings.length > 0) {
            const warningsList = warnings.slice(0, 3).map(w => {
                const ts = Math.floor(new Date(w.created_at + 'Z').getTime() / 1000);
                return `**${w.reason}** - <t:${ts}:R>`;
            });
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

    return { createTrade, handleButtonInteraction, showTrades, showTradeStats };
}

module.exports = init;
