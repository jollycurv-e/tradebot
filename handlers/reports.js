const { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { debug } = require('../utils.js');

function init(hub) {
    async function reportTrade(interaction, tradeId, reason, description) {
        const reporterId = interaction.user.id;
        const guildId = interaction.guild.id;

        let trade;
        try {
            trade = await hub.api('GET', `/tradebot/trade/${tradeId}`);
        } catch (err) {
            if (err.status === 404) {
                return interaction.reply({ content: '❌ Trade not found!', flags: 64 });
            }
            throw err;
        }

        if (trade.initiator_id !== reporterId && trade.recipient_id !== reporterId) {
            return interaction.reply({ content: '❌ You can only report trades you are involved in!', flags: 64 });
        }

        const reportedUserId = trade.initiator_id === reporterId ? trade.recipient_id : trade.initiator_id;

        let reportId;
        try {
            const result = await hub.api('POST', '/tradebot/report', {
                trade_id: tradeId,
                reporter_id: reporterId,
                reported_user_id: reportedUserId,
                reason,
                description,
                guild_id: guildId
            });
            reportId = result.id;
        } catch (err) {
            if (err.status === 409) {
                return interaction.reply({ content: '❌ You have already reported this trade!', flags: 64 });
            }
            throw err;
        }

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

        await interaction.reply({ embeds: [embed], flags: 64 });

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

        const posted = await sendToModChannel(interaction, modLogEmbed, reportId, false);
        if (!posted) {
            await hub.api('DELETE', `/tradebot/report/${reportId}`);
            await interaction.followUp({ content: '❌ Your report could not be delivered to the moderation team — the bot lacks permission to post in the mod channel. Please contact a moderator directly.', flags: 64 });
        }
    }

    async function reportUser(interaction, user, reason, description) {
        const reporterId = interaction.user.id;
        const guildId = interaction.guild.id;

        if (user.id === reporterId) {
            return interaction.reply({ content: '❌ You cannot report yourself!', flags: 64 });
        }
        if (user.bot) {
            return interaction.reply({ content: '❌ You cannot report bots!', flags: 64 });
        }

        const { id: reportId } = await hub.api('POST', '/tradebot/report', {
            trade_id: null,
            reporter_id: reporterId,
            reported_user_id: user.id,
            reason,
            description,
            guild_id: guildId
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

        await interaction.reply({ embeds: [embed], flags: 64 });

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

        const posted = await sendToModChannel(interaction, modLogEmbed, reportId, true);
        if (!posted) {
            await hub.api('DELETE', `/tradebot/report/${reportId}`);
            await interaction.followUp({ content: '❌ Your report could not be delivered to the moderation team — the bot lacks permission to post in the mod channel. Please contact a moderator directly.', flags: 64 });
        }
    }

    async function handleReportButton(interaction, tradeId, userId) {
        let trade;
        try {
            trade = await hub.api('GET', `/tradebot/trade/${tradeId}`);
        } catch (err) {
            if (err.status === 404) {
                return interaction.reply({ content: '❌ Trade not found!', flags: 64 });
            }
            throw err;
        }

        if (trade.initiator_id !== userId && trade.recipient_id !== userId) {
            return interaction.reply({ content: '❌ You can only report trades you are involved in!', flags: 64 });
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
                flags: 64
            });
        }

        await reportTrade(interaction, parseInt(tradeId), reason, description);
    }

    async function sendToModChannel(interaction, embed, reportId, isUserReport = false) {
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

        const modChannels = ['mod-logs', 'mod-log', 'modlogs', 'modlog', 'staff-logs', 'reports'];
        let posted = false;
        for (const channelName of modChannels) {
            const channel = interaction.guild.channels.cache.find(ch => ch.name === channelName && ch.type === 0);
            if (channel) {
                debug(`Found mod channel: #${channel.name} (${channel.id}), attempting send...`);
                await channel.send({ embeds: [embed], components: [row] })
                    .then(() => { debug(`Successfully posted report #${reportId} to #${channel.name}`); posted = true; })
                    .catch(err => debug(`Failed to post report #${reportId} to #${channel.name}:`, err.message));
                break;
            }
        }
        if (!posted) debug(`No mod channel found in guild. Searched: ${modChannels.join(', ')}`);
        return posted;
    }

    return { reportTrade, reportUser, handleReportButton, handleModalSubmit };
}

module.exports = init;
