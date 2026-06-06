const { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

function init(db) {
    async function reportTrade(interaction, tradeId, reason, description) {
        const reporterId = interaction.user.id;
        const guildId = interaction.guild.id;

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

        if (trade.initiator_id !== reporterId && trade.recipient_id !== reporterId) {
            return interaction.reply({ content: '❌ You can only report trades you are involved in!', ephemeral: true });
        }

        const reportedUserId = trade.initiator_id === reporterId ? trade.recipient_id : trade.initiator_id;

        const existingReport = await new Promise((resolve, reject) => {
            db.get(
                'SELECT id FROM trade_reports WHERE trade_id = ? AND reporter_id = ?',
                [tradeId, reporterId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (existingReport) {
            return interaction.reply({ content: '❌ You have already reported this trade!', ephemeral: true });
        }

        const reportId = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO trade_reports (trade_id, reporter_id, reported_user_id, reason, description, guild_id) VALUES (?, ?, ?, ?, ?, ?)',
                [tradeId, reporterId, reportedUserId, reason, description, guildId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('📋 Trade Report Submitted')
            .setDescription(`Report ID: ${reportId}`)
            .addFields(
                { name: '🔍 Trade ID', value: `#${tradeId}`, inline: true },
                { name: '⚠️ Reason', value: reason, inline: true },
                { name: '👤 Reported User', value: `<@${reportedUserId}>`, inline: true }
            )
            .setColor('#ff9900')
            .setFooter({ text: 'Moderators will review this report shortly' });

        if (description) {
            embed.addFields({ name: '📝 Additional Details', value: description, inline: false });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });

        const modLogEmbed = new EmbedBuilder()
            .setTitle('🚨 New Trade Report')
            .setDescription(`Report ID: ${reportId}`)
            .addFields(
                { name: 'Trade ID', value: `#${tradeId}`, inline: true },
                { name: 'Reporter', value: `<@${reporterId}>`, inline: true },
                { name: 'Reported User', value: `<@${reportedUserId}>`, inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'Trade Description', value: trade.description, inline: false }
            )
            .setColor('#ff0000');

        if (description) {
            modLogEmbed.addFields({ name: 'Report Details', value: description, inline: false });
        }

        await sendToModChannel(interaction, modLogEmbed);
    }

    async function reportUser(interaction, user, reason, description) {
        const reporterId = interaction.user.id;
        const guildId = interaction.guild.id;

        if (user.id === reporterId) {
            return interaction.reply({ content: '❌ You cannot report yourself!', ephemeral: true });
        }

        if (user.bot) {
            return interaction.reply({ content: '❌ You cannot report bots!', ephemeral: true });
        }

        const now = new Date().toISOString();
        const reportId = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO trade_reports (trade_id, reporter_id, reported_user_id, reason, description, guild_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [0, reporterId, user.id, reason, description, guildId, now],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('📋 User Report Submitted')
            .setDescription(`Report ID: ${reportId}`)
            .addFields(
                { name: '👤 Reported User', value: `<@${user.id}>`, inline: true },
                { name: '⚠️ Reason', value: reason, inline: true },
                { name: '📝 Reporter', value: `<@${reporterId}>`, inline: true }
            )
            .setColor('#ff9900')
            .setFooter({ text: 'Moderators will review this report shortly' });

        if (description) {
            embed.addFields({ name: '📄 Additional Details', value: description, inline: false });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });

        const modLogEmbed = new EmbedBuilder()
            .setTitle('🚨 New User Report')
            .setDescription(`Report ID: ${reportId}`)
            .addFields(
                { name: 'Reporter', value: `<@${reporterId}>`, inline: true },
                { name: 'Reported User', value: `<@${user.id}>`, inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'Type', value: 'General User Report', inline: true }
            )
            .setColor('#ff0000');

        if (description) {
            modLogEmbed.addFields({ name: 'Report Details', value: description, inline: false });
        }

        await sendToModChannel(interaction, modLogEmbed);
    }

    async function handleReportButton(interaction, tradeId, userId) {
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

        if (trade.initiator_id !== userId && trade.recipient_id !== userId) {
            return interaction.reply({ content: '❌ You can only report trades you are involved in!', ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId(`report_modal_${tradeId}`)
            .setTitle('Report Trade');

        const reasonInput = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason')
            .setPlaceholder('scam, harassment, spam, inappropriate, other')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Additional details (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000);

        modal.addComponents(
            new ActionRowBuilder().addComponents(reasonInput),
            new ActionRowBuilder().addComponents(descriptionInput)
        );

        await interaction.showModal(modal);
    }

    async function handleModalSubmit(interaction) {
        if (!interaction.customId.startsWith('report_modal_')) return;

        const tradeId = interaction.customId.split('_')[2];
        const reason = interaction.fields.getTextInputValue('reason').toLowerCase().trim();
        const description = interaction.fields.getTextInputValue('description') || '';

        const validReasons = ['scam', 'harassment', 'spam', 'inappropriate', 'other'];
        if (!validReasons.includes(reason)) {
            return interaction.reply({
                content: '❌ Invalid reason! Use: scam, harassment, spam, inappropriate, or other',
                ephemeral: true
            });
        }

        await reportTrade(interaction, parseInt(tradeId), reason, description);
    }

    async function sendToModChannel(interaction, embed) {
        const modChannels = ['mod-logs', 'modlog', 'staff-logs', 'reports'];
        for (const channelName of modChannels) {
            const channel = interaction.guild.channels.cache.find(ch => ch.name === channelName && ch.type === 0);
            if (channel) {
                await channel.send({ embeds: [embed] }).catch(() => {});
                break;
            }
        }
    }

    return { reportTrade, reportUser, handleReportButton, handleModalSubmit };
}

module.exports = init;
